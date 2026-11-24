// @vitest-environment node

// Automatic host trust and the publish trust predicate, driven against real rows in a rolled-back
// transaction. Accounts are made through the real sign-up, code verification and role services, and
// staff trust goes through the real elevation service, so each guard below sees the input the
// production path builds. A row is planted directly only where this file does not drive the writer,
// and each such helper says so.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
  sweepForAccount: vi.fn().mockResolvedValue(undefined),
  enqueueApproved: vi.fn(),
}));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: { ...actual.serverEnv, authSecret: "test-registration-code-secret" },
  };
});

vi.mock("@/server/auth/email-verification", () => ({
  sendRegistrationVerificationEmail: async (options: { email: string; code: string }) => {
    mocks.sentCodes.push({ email: options.email, code: options.code });
  },
}));

vi.mock("@/server/redis/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/redis/rate-limit")>();
  return {
    ...actual,
    checkFixedWindowLimitFailClosed: async (params: {
      key: string;
      limit: number;
      windowSeconds: number;
    }) => {
      const count = (mocks.windowCounts.get(params.key) ?? 0) + 1;
      mocks.windowCounts.set(params.key, count);
      if (count > params.limit) {
        return { decision: "throttled" as const, retryAfterSeconds: params.windowSeconds };
      }
      return { decision: "allowed" as const };
    },
  };
});

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, enqueueRecruiterVerificationApproved: mocks.enqueueApproved };
});

vi.mock(
  "@/server/recruiter-verification/recruiter-verification-service",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/server/recruiter-verification/recruiter-verification-service")
      >();
    return { ...actual, sweepOrphanedObjectsForAccount: mocks.sweepForAccount };
  },
);

import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import { createPersonalInstitutionForUser } from "@/server/institution-workspace/institution-service";
import { elevateRecruiterTier } from "@/server/recruiter-tier/recruiter-tier-service";
import { extractEmailDomain } from "./email-domain";
import {
  automaticTrustEligibility,
  isPublishTrustSatisfied,
  resolveAutomaticTrustSource,
  trustHostInTransaction,
} from "./host-trust-service";

const PASSWORD = "fresh-pass-3";

const CANDIDATE_DETAILS = {
  name: "Rina Pratama",
  signupRole: "candidate",
  fullName: "Rina Pratama",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;
afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const inRollback = async (test: (tx: Database) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("No test database");
  try {
    await db.transaction(async (tx) => {
      await test(tx as unknown as Database);
      (tx as Tx).rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

beforeEach(() => {
  mocks.sentCodes.length = 0;
  mocks.windowCounts.clear();
});

const latestCode = (): string => {
  const sent = mocks.sentCodes.at(-1);
  if (!sent) throw new Error("No code was sent");
  return sent.code;
};

const userIdOfAddress = async (tx: Database, address: string): Promise<string> => {
  const [row] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, address));
  if (!row) throw new Error("No user row");
  return row.id;
};

const seedOperator = async (tx: Database): Promise<string> => {
  const suffix = randomUUID();
  const [row] = await tx
    .insert(schema.users)
    .values({
      email: `ops_trust_${suffix}@example.test`,
      username: `ops_trust_${suffix}`,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No operator row");
  return row.id;
};

const signUpParticipant = async (tx: Database, address: string): Promise<string> => {
  await registerUserWithCredentials(
    { ...CANDIDATE_DETAILS, email: address, password: PASSWORD },
    tx,
  );
  await verifyEmailCodeAndSetPassword(
    { ...CANDIDATE_DETAILS, email: address, code: latestCode(), password: PASSWORD },
    tx,
  );
  return userIdOfAddress(tx, address);
};

const signUpHost = async (tx: Database, address: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address);
  await markRoleAsVerified(
    userId,
    "recruiter",
    null,
    { fullName: "Budi Santoso", mobileNumber: "081298765432", corporateEmail: null },
    tx,
  );
  return userId;
};

const trustByStaff = async (tx: Database, userId: string): Promise<void> => {
  const operatorId = await seedOperator(tx);
  await elevateRecruiterTier(operatorId, userId, tx);
};

const ownWorkspace = async (tx: Database, userId: string): Promise<string> => {
  const workspace = await createPersonalInstitutionForUser(userId, tx);
  return workspace.institutionId;
};

// Planted directly: a stand-in for the organization email confirmation, which this file does not drive.
const plantOrganizationEmail = async (
  tx: Database,
  userId: string,
  email: string,
): Promise<void> => {
  await tx.insert(schema.hostOrganizationEmails).values({
    userId,
    email,
    domain: extractEmailDomain(email)!,
    confirmedAt: new Date(),
  });
};

// Planted directly: a stand-in for a staff trust removal, which this file does not drive.
const plantTrustRemoval = async (tx: Database, userId: string): Promise<void> => {
  await tx
    .update(schema.users)
    .set({ hostTrustRemovedAt: new Date() })
    .where(eq(schema.users.id, userId));
};

// Planted directly: a stand-in for an accepted invitation, which this file does not drive.
const plantMembership = async (
  tx: Database,
  institutionId: string,
  userId: string,
  membershipRole: "institution_owner" | "institution_staff" | "institution_member",
  status: "active" | "inactive",
): Promise<void> => {
  await tx.insert(schema.institutionMemberships).values({
    institutionId,
    userId,
    membershipRole,
    status,
  });
};

// Planted directly: a host tier without the host role, a state no sign-up writes and older accounts
// can still hold.
const plantHostTierWithoutHostRole = async (tx: Database, userId: string): Promise<void> => {
  await tx
    .update(schema.users)
    .set({ recruiterVerificationTier: "minimal" })
    .where(eq(schema.users.id, userId));
};

const tierOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ tier: schema.users.recruiterVerificationTier })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.tier;
};

const recruiterVerifiedAtOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ recruiterVerifiedAt: schema.users.recruiterVerifiedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.recruiterVerifiedAt;
};

const organizationEmailRowsOf = (tx: Database, userId: string) =>
  tx
    .select({
      email: schema.hostOrganizationEmails.email,
      domain: schema.hostOrganizationEmails.domain,
    })
    .from(schema.hostOrganizationEmails)
    .where(eq(schema.hostOrganizationEmails.userId, userId));

describe.skipIf(skipWithoutDatabase)("host trust (real database)", () => {
  describe("automatic trust", () => {
    it("trusts a host whose confirmed sign-in email is on an organization domain and records that address", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "budi.host@acme.example");

        expect(await trustHostInTransaction(tx, userId)).toBe("sign_in_email");

        expect(await tierOf(tx, userId)).toBe("elevated");
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([
          { email: "budi.host@acme.example", domain: "acme.example" },
        ]);
      });
    });

    it("does not trust a host whose sign-in email is on a free provider", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "rina.free@gmail.com");

        expect(await resolveAutomaticTrustSource(tx, userId)).toBeNull();
        expect(await trustHostInTransaction(tx, userId)).toBeNull();

        expect(await tierOf(tx, userId)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([]);
      });
    });

    it("trusts a host by its Email organisasi when its sign-in email is free", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "rina.free@gmail.com");
        await plantOrganizationEmail(tx, userId, "rina@acme.example");

        expect(await trustHostInTransaction(tx, userId)).toBe("organization_email");

        expect(await tierOf(tx, userId)).toBe("elevated");
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([
          { email: "rina@acme.example", domain: "acme.example" },
        ]);
      });
    });

    it("does not trust a host whose trust staff removed", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "budi.host@acme.example");
        await plantOrganizationEmail(tx, userId, "budi@acme.example");
        await plantTrustRemoval(tx, userId);

        expect(await trustHostInTransaction(tx, userId)).toBeNull();

        expect(await tierOf(tx, userId)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([
          { email: "budi@acme.example", domain: "acme.example" },
        ]);
      });
    });

    it("does not trust an operational account", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "ops.host@acme.example");
        await tx
          .update(schema.users)
          .set({ role: "platform_ops" })
          .where(eq(schema.users.id, userId));

        expect(await trustHostInTransaction(tx, userId)).toBeNull();

        expect(await tierOf(tx, userId)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([]);
      });
    });

    // No production path reaches this state: no sign-up writes a host tier, so it is planted.
    it("does not trust an account without the host role", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpParticipant(tx, "rina.peserta@acme.example");
        await plantHostTierWithoutHostRole(tx, userId);

        expect(await trustHostInTransaction(tx, userId)).toBeNull();

        expect(await tierOf(tx, userId)).toBe("minimal");
        expect(await recruiterVerifiedAtOf(tx, userId)).toBeNull();
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([]);
      });
    });

    it("reports no trust write for a host who is already trusted", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "budi.host@acme.example");
        await trustByStaff(tx, userId);

        expect(await trustHostInTransaction(tx, userId)).toBeNull();

        expect(await tierOf(tx, userId)).toBe("elevated");
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([]);
      });
    });

    // No production path reaches this arm: a credentials account cannot sign in unverified and a
    // Google sign-up on an unverified address is refused (DEC-0263). The row is planted.
    it("does not trust an account whose sign-in email is unconfirmed", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "budi.host@acme.example");
        await plantOrganizationEmail(tx, userId, "budi@acme.example");
        await tx
          .update(schema.users)
          .set({ emailVerified: null })
          .where(eq(schema.users.id, userId));

        expect(await trustHostInTransaction(tx, userId)).toBeNull();

        expect(await tierOf(tx, userId)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([
          { email: "budi@acme.example", domain: "acme.example" },
        ]);
      });
    });

    it("does not trust on a sign-in address another account holds as its Email organisasi", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpHost(tx, "budi.host@acme.example");
        const accountB = await signUpParticipant(tx, "dina@acme.example");
        await plantOrganizationEmail(tx, accountB, "budi.host@acme.example");

        expect(await resolveAutomaticTrustSource(tx, accountA)).toBeNull();
        expect(await trustHostInTransaction(tx, accountA)).toBeNull();

        expect(await tierOf(tx, accountA)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, accountA)).toEqual([]);
      });
    });

    it("does not trust on an Email organisasi that is now another account's sign-in email", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpHost(tx, "rina.free@gmail.com");
        await plantOrganizationEmail(tx, accountA, "dina@acme.example");
        await signUpParticipant(tx, "dina@acme.example");

        expect(await resolveAutomaticTrustSource(tx, accountA)).toBeNull();
        expect(await trustHostInTransaction(tx, accountA)).toBeNull();

        expect(await tierOf(tx, accountA)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, accountA)).toEqual([
          { email: "dina@acme.example", domain: "acme.example" },
        ]);
      });
    });

    it("reads a removed host as not eligible through the shared predicate", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "budi.host@acme.example");
        const eligibleUsers = () =>
          tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(and(eq(schema.users.id, userId), automaticTrustEligibility));

        expect(await eligibleUsers()).toEqual([{ id: userId }]);

        await plantTrustRemoval(tx, userId);

        expect(await eligibleUsers()).toEqual([]);
      });
    });

    // Same reason as the unconfirmed sign-in email test above: no production path reaches it.
    it("does not take an unconfirmed sign-in email as a source", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "budi.host@acme.example");
        await tx
          .update(schema.users)
          .set({ emailVerified: null })
          .where(eq(schema.users.id, userId));

        expect(await resolveAutomaticTrustSource(tx, userId)).toBeNull();
      });
    });

    it("keeps an Email organisasi row and does not trust when the sign-in email cannot be recorded", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpHost(tx, "budi.host@acme.example");
        await plantOrganizationEmail(tx, accountA, "dina@acme.example");
        await signUpParticipant(tx, "dina@acme.example");

        expect(await resolveAutomaticTrustSource(tx, accountA)).toBe("sign_in_email");
        expect(await trustHostInTransaction(tx, accountA)).toBeNull();

        expect(await tierOf(tx, accountA)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, accountA)).toEqual([
          { email: "dina@acme.example", domain: "acme.example" },
        ]);
      });
    });

    it("does not take a sign-in email with a non-ASCII character as a source", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "budi.müller@acme.example");

        expect(await resolveAutomaticTrustSource(tx, userId)).toBeNull();
        expect(await trustHostInTransaction(tx, userId)).toBeNull();

        expect(await tierOf(tx, userId)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([]);
      });
    });

    it("does not take a sign-in email whose domain ends in a dot as a source", async () => {
      await inRollback(async (tx) => {
        const userId = await signUpHost(tx, "x@gmail.com.");

        expect(await resolveAutomaticTrustSource(tx, userId)).toBeNull();
        expect(await trustHostInTransaction(tx, userId)).toBeNull();

        expect(await tierOf(tx, userId)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, userId)).toEqual([]);
      });
    });
  });

  describe("publish trust", () => {
    it("is satisfied by the actor's own trust", async () => {
      await inRollback(async (tx) => {
        const owner = await signUpHost(tx, "owner.one@acme.example");
        const workspace = await ownWorkspace(tx, owner);
        const actor = await signUpHost(tx, "actor@acme.example");
        await trustByStaff(tx, actor);

        expect(await isPublishTrustSatisfied(actor, workspace, tx)).toBe(true);
      });
    });

    it("is satisfied for an untrusted actor when an active owner of that institution is trusted", async () => {
      await inRollback(async (tx) => {
        const owner = await signUpHost(tx, "owner.one@acme.example");
        await trustByStaff(tx, owner);
        const workspace = await ownWorkspace(tx, owner);
        const actor = await signUpHost(tx, "actor@acme.example");

        expect(await isPublishTrustSatisfied(actor, workspace, tx)).toBe(true);
      });
    });

    it("is not satisfied by a trusted owner who is deactivated", async () => {
      await inRollback(async (tx) => {
        const owner = await signUpHost(tx, "owner.one@acme.example");
        await trustByStaff(tx, owner);
        const workspace = await ownWorkspace(tx, owner);
        const actor = await signUpHost(tx, "actor@acme.example");
        await tx
          .update(schema.users)
          .set({ status: "deactivated" })
          .where(eq(schema.users.id, owner));

        expect(await isPublishTrustSatisfied(actor, workspace, tx)).toBe(false);
      });
    });

    it("is not satisfied by a trusted owner who is suspended", async () => {
      await inRollback(async (tx) => {
        const owner = await signUpHost(tx, "owner.one@acme.example");
        await trustByStaff(tx, owner);
        const workspace = await ownWorkspace(tx, owner);
        const actor = await signUpHost(tx, "actor@acme.example");
        await tx
          .update(schema.users)
          .set({ suspendedAt: new Date() })
          .where(eq(schema.users.id, owner));

        expect(await isPublishTrustSatisfied(actor, workspace, tx)).toBe(false);
      });
    });

    it("is not satisfied by a trusted owner of another institution", async () => {
      await inRollback(async (tx) => {
        const untrustedOwner = await signUpHost(tx, "owner.one@acme.example");
        const untrustedOwnersWorkspace = await ownWorkspace(tx, untrustedOwner);
        const trustedOwner = await signUpHost(tx, "owner.two@acme.example");
        await trustByStaff(tx, trustedOwner);
        await ownWorkspace(tx, trustedOwner);
        const actor = await signUpHost(tx, "actor@acme.example");

        expect(await isPublishTrustSatisfied(actor, untrustedOwnersWorkspace, tx)).toBe(false);
      });
    });

    it("is not satisfied by a trusted institution_member or institution_staff who is not an owner", async () => {
      await inRollback(async (tx) => {
        const owner = await signUpHost(tx, "owner.one@acme.example");
        const workspace = await ownWorkspace(tx, owner);
        const member = await signUpHost(tx, "member@acme.example");
        await trustByStaff(tx, member);
        await plantMembership(tx, workspace, member, "institution_member", "active");
        const staff = await signUpHost(tx, "staff@acme.example");
        await trustByStaff(tx, staff);
        await plantMembership(tx, workspace, staff, "institution_staff", "active");
        const actor = await signUpHost(tx, "actor@acme.example");

        expect(await isPublishTrustSatisfied(actor, workspace, tx)).toBe(false);
      });
    });

    it("is not satisfied for an actor whose trust staff removed, even with a trusted owner", async () => {
      await inRollback(async (tx) => {
        const owner = await signUpHost(tx, "owner.one@acme.example");
        await trustByStaff(tx, owner);
        const workspace = await ownWorkspace(tx, owner);
        const actor = await signUpHost(tx, "actor@acme.example");
        await plantTrustRemoval(tx, actor);

        expect(await isPublishTrustSatisfied(actor, workspace, tx)).toBe(false);
      });
    });

    it("is not satisfied by a trusted owner whose membership is not active", async () => {
      await inRollback(async (tx) => {
        const untrustedOwner = await signUpHost(tx, "owner.one@acme.example");
        const workspace = await ownWorkspace(tx, untrustedOwner);
        const inactiveOwner = await signUpHost(tx, "owner.inactive@acme.example");
        await trustByStaff(tx, inactiveOwner);
        await plantMembership(tx, workspace, inactiveOwner, "institution_owner", "inactive");
        const actor = await signUpHost(tx, "actor@acme.example");

        expect(await isPublishTrustSatisfied(actor, workspace, tx)).toBe(false);
      });
    });
  });
});
