// @vitest-environment node
//
// requireOwnerInstitutionBySlug against a real database.
//
// The routes that use it mock it, so those tests prove the WIRING and nothing about the guard. This
// file is the other half: the guard's own behaviour, on real membership rows, with the separation
// it exists to enforce stated as its own case — a STAFF member of the right institution is refused,
// which is the only thing this resolver does that requireAdminInstitutionBySlug does not.
//
// Every test runs inside a transaction that is always rolled back.

import { afterAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError } from "drizzle-orm";
import postgres from "postgres";
import { institutionMemberships, institutions, users } from "@/server/db/schema";
import { AccessError } from "@/server/auth/access-core";
import type { Database } from "@/server/db/client";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

const seedUser = async (tx: Tx, label: string): Promise<string> => {
  const id = uniqueSuffix();
  const [user] = await tx
    .insert(users)
    .values({
      email: `${label}_${id}@example.test`,
      username: `${label}_${id}`,
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return user!.id;
};

const seedInstitution = async (tx: Tx, label: string): Promise<{ id: string; slug: string }> => {
  const id = uniqueSuffix();
  const slug = `${label}-inst-${id}`;
  const [institution] = await tx
    .insert(institutions)
    .values({ slug, institutionType: "personal", verificationStatus: "verified" })
    .returning({ id: institutions.id });
  return { id: institution!.id, slug };
};

const seedMembership = async (
  tx: Tx,
  institutionId: string,
  userId: string,
  membershipRole: "institution_owner" | "institution_staff" | "institution_member",
  status: "invited" | "active" | "inactive" | "revoked" = "active",
) => {
  await tx.insert(institutionMemberships).values({ institutionId, userId, membershipRole, status });
};

// THE OWNER-OR-STAFF GATE ITSELF, which 43 call sites depend on and which nothing tested.
//
// Found by probing the generalisation that introduced `requireMembershipBySlug`: widening this
// resolver to admit `institution_member` — handing every ordinary member the organiser powers of an
// owner across the participants console, competition editing, member management, invitations, the
// audit log and this step's payment verdicts — left all 2596 tests green. Narrowing it to refuse
// every staff member left 2589 green, caught only by a pairing control written for a different
// test on the same day.
//
// The guard was correct. Nothing would have reported it ceasing to be.
describe.skipIf(skipWithoutDatabase)("requireAdminInstitutionBySlug (real database)", () => {
  it("admits an OWNER", async () => {
    await inRollback(async (tx) => {
      const owner = await seedUser(tx, "aowner");
      const institution = await seedInstitution(tx, "adm");
      await seedMembership(tx, institution.id, owner, "institution_owner");

      const { requireAdminInstitutionBySlug } = await import("./member-service");
      const resolved = await requireAdminInstitutionBySlug(
        owner,
        institution.slug,
        tx as unknown as Database,
      );

      expect(resolved.institutionId).toBe(institution.id);
    });
  });

  it("admits a STAFF member", async () => {
    // Narrowing the role set is fail-safe rather than dangerous, but it is still a silent
    // regression: it locks every staff member out of every organiser surface at once.
    await inRollback(async (tx) => {
      const staff = await seedUser(tx, "astaff");
      const institution = await seedInstitution(tx, "adm");
      await seedMembership(tx, institution.id, staff, "institution_staff");

      const { requireAdminInstitutionBySlug } = await import("./member-service");
      const resolved = await requireAdminInstitutionBySlug(
        staff,
        institution.slug,
        tx as unknown as Database,
      );

      expect(resolved.institutionId).toBe(institution.id);
    });
  });

  it("REFUSES an institution_member — the privilege-escalation direction", async () => {
    // The one that matters. `institution_member` is the ordinary membership an invitation grants;
    // admitting it here would silently promote every member of every institution to organiser.
    await inRollback(async (tx) => {
      const member = await seedUser(tx, "amember");
      const institution = await seedInstitution(tx, "adm");
      await seedMembership(tx, institution.id, member, "institution_member");

      const { requireAdminInstitutionBySlug } = await import("./member-service");

      await expect(
        requireAdminInstitutionBySlug(member, institution.slug, tx as unknown as Database),
      ).rejects.toBeInstanceOf(AccessError);
    });
  });

  it("REFUSES a staff member whose membership is no longer active", async () => {
    await inRollback(async (tx) => {
      const exStaff = await seedUser(tx, "aexstaff");
      const institution = await seedInstitution(tx, "adm");
      await seedMembership(tx, institution.id, exStaff, "institution_staff", "revoked");

      const { requireAdminInstitutionBySlug } = await import("./member-service");

      await expect(
        requireAdminInstitutionBySlug(exStaff, institution.slug, tx as unknown as Database),
      ).rejects.toBeInstanceOf(AccessError);
    });
  });

  it("REFUSES an admin of a DIFFERENT institution, in both directions", async () => {
    await inRollback(async (tx) => {
      const staffA = await seedUser(tx, "astaffa");
      const ownerD = await seedUser(tx, "aownerd");
      const instA = await seedInstitution(tx, "aalpha");
      const instD = await seedInstitution(tx, "adelta");
      await seedMembership(tx, instA.id, staffA, "institution_staff");
      await seedMembership(tx, instD.id, ownerD, "institution_owner");

      const { requireAdminInstitutionBySlug } = await import("./member-service");

      await expect(
        requireAdminInstitutionBySlug(staffA, instD.slug, tx as unknown as Database),
      ).rejects.toBeInstanceOf(AccessError);
      await expect(
        requireAdminInstitutionBySlug(ownerD, instA.slug, tx as unknown as Database),
      ).rejects.toBeInstanceOf(AccessError);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("requireOwnerInstitutionBySlug (real database)", () => {
  it("resolves the institution for its OWNER", async () => {
    // The positive. Every refusal below means nothing without it.
    await inRollback(async (tx) => {
      const owner = await seedUser(tx, "owner");
      const institution = await seedInstitution(tx, "own");
      await seedMembership(tx, institution.id, owner, "institution_owner");

      const { requireOwnerInstitutionBySlug } = await import("./member-service");
      const resolved = await requireOwnerInstitutionBySlug(
        owner,
        institution.slug,
        tx as unknown as Database,
      );

      expect(resolved.institutionId).toBe(institution.id);
    });
  });

  it("REFUSES a STAFF member of that same institution", async () => {
    // The separation this resolver exists for. Staff rule on whether a transfer arrived; the owner
    // decides where transfers are sent. One person holding both could redirect the money and then
    // confirm it as received.
    //
    // Paired directly with the case below, which shows the SAME user resolving through the
    // owner-or-staff resolver — so this is a refusal about the ROLE, not a broken fixture.
    await inRollback(async (tx) => {
      const staff = await seedUser(tx, "staff");
      const institution = await seedInstitution(tx, "own");
      await seedMembership(tx, institution.id, staff, "institution_staff");

      const { requireOwnerInstitutionBySlug } = await import("./member-service");

      await expect(
        requireOwnerInstitutionBySlug(staff, institution.slug, tx as unknown as Database),
      ).rejects.toBeInstanceOf(AccessError);
    });
  });

  it("admits that same staff member through the owner-OR-staff resolver", async () => {
    await inRollback(async (tx) => {
      const staff = await seedUser(tx, "staff");
      const institution = await seedInstitution(tx, "own");
      await seedMembership(tx, institution.id, staff, "institution_staff");

      const { requireAdminInstitutionBySlug } = await import("./member-service");
      const resolved = await requireAdminInstitutionBySlug(
        staff,
        institution.slug,
        tx as unknown as Database,
      );

      expect(resolved.institutionId).toBe(institution.id);
    });
  });

  it("REFUSES the owner of a DIFFERENT institution", async () => {
    // The cross-tenant negative, with a second complete tenant rather than a bare id: owning one
    // institution must grant nothing at another, and a fixture with only one institution cannot
    // tell the difference.
    await inRollback(async (tx) => {
      const ownerA = await seedUser(tx, "ownera");
      const ownerD = await seedUser(tx, "ownerd");
      const instA = await seedInstitution(tx, "alpha");
      const instD = await seedInstitution(tx, "delta");
      await seedMembership(tx, instA.id, ownerA, "institution_owner");
      await seedMembership(tx, instD.id, ownerD, "institution_owner");

      const { requireOwnerInstitutionBySlug } = await import("./member-service");

      // Both directions, with two different outsiders — not one standing in for both.
      await expect(
        requireOwnerInstitutionBySlug(ownerD, instA.slug, tx as unknown as Database),
      ).rejects.toBeInstanceOf(AccessError);
      await expect(
        requireOwnerInstitutionBySlug(ownerA, instD.slug, tx as unknown as Database),
      ).rejects.toBeInstanceOf(AccessError);
    });
  });

  it("REFUSES an owner whose membership is no longer active", async () => {
    // A revoked owner keeps their row; only `status` says they are gone. Without the status
    // predicate a removed owner would keep the right to repoint the institution's bank account.
    await inRollback(async (tx) => {
      const owner = await seedUser(tx, "exowner");
      const institution = await seedInstitution(tx, "own");
      await seedMembership(tx, institution.id, owner, "institution_owner", "revoked");

      const { requireOwnerInstitutionBySlug } = await import("./member-service");

      await expect(
        requireOwnerInstitutionBySlug(owner, institution.slug, tx as unknown as Database),
      ).rejects.toBeInstanceOf(AccessError);
    });
  });

  it("REFUSES an institution_member, who is neither owner nor staff", async () => {
    await inRollback(async (tx) => {
      const member = await seedUser(tx, "member");
      const institution = await seedInstitution(tx, "own");
      await seedMembership(tx, institution.id, member, "institution_member");

      const { requireOwnerInstitutionBySlug } = await import("./member-service");

      await expect(
        requireOwnerInstitutionBySlug(member, institution.slug, tx as unknown as Database),
      ).rejects.toBeInstanceOf(AccessError);
    });
  });

  it("refuses an unknown slug the same way it refuses a forbidden one", async () => {
    // Identical refusal for "no such institution" and "not yours", so the resolver cannot be used
    // to enumerate which slugs exist.
    await inRollback(async (tx) => {
      const owner = await seedUser(tx, "owner");
      const institution = await seedInstitution(tx, "own");
      await seedMembership(tx, institution.id, owner, "institution_owner");

      const { requireOwnerInstitutionBySlug } = await import("./member-service");

      const refusalFor = async (slug: string) => {
        try {
          await requireOwnerInstitutionBySlug(owner, slug, tx as unknown as Database);
          return null;
        } catch (error) {
          if (!(error instanceof AccessError)) throw error;
          return { status: error.status, message: error.message };
        }
      };

      const missing = await refusalFor(`${institution.slug}-does-not-exist`);
      const forbidden = await refusalFor(await seedInstitution(tx, "other").then((i) => i.slug));

      expect(missing).not.toBeNull();
      expect(missing).toEqual(forbidden);
    });
  });
});
