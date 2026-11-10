// @vitest-environment node
//
// The institution media owner check against a real database.
//
// The upload routes mock the media service, so their tests prove the wiring and nothing about who
// may sign an upload. This file is the other half: the owner lookup on real membership rows, with
// staff, a plain member and another institution's owner each refused.
//
// Every test runs inside a transaction that is always rolled back.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError } from "drizzle-orm";
import postgres from "postgres";
import { institutionMemberships, institutions, users } from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { generateInstitutionMediaUploadUrl } from "@/server/institution-workspace/institution-media-service";

const { generatePresignedPutUrl } = vi.hoisted(() => ({
  generatePresignedPutUrl: vi.fn(async () => "https://signed.example/put"),
}));

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => true,
  generatePresignedPutUrl,
}));

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

afterEach(() => vi.clearAllMocks());

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
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

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
    .values({
      slug,
      institutionType: "company",
      displayName: `Media Fixture ${id}`,
      verificationStatus: "verified",
    })
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

type MediaFixture = {
  institutionA: { id: string; slug: string };
  ownerA: string;
  staffA: string;
  memberA: string;
  ownerB: string;
};

const seedMediaFixture = async (tx: Tx): Promise<MediaFixture> => {
  const institutionA = await seedInstitution(tx, "media-a");
  const ownerA = await seedUser(tx, "mownera");
  const staffA = await seedUser(tx, "mstaffa");
  const memberA = await seedUser(tx, "mmembera");
  await seedMembership(tx, institutionA.id, ownerA, "institution_owner");
  await seedMembership(tx, institutionA.id, staffA, "institution_staff");
  await seedMembership(tx, institutionA.id, memberA, "institution_member");

  const institutionB = await seedInstitution(tx, "media-b");
  const ownerB = await seedUser(tx, "mownerb");
  await seedMembership(tx, institutionB.id, ownerB, "institution_owner");

  return { institutionA, ownerA, staffA, memberA, ownerB };
};

const requestLogoUploadUrl = (tx: Tx, userId: string, slug: string) =>
  generateInstitutionMediaUploadUrl(
    userId,
    slug,
    "logo",
    { contentType: "image/png" },
    tx as unknown as Database,
  );

describe.skipIf(skipWithoutDatabase)(
  "the institution media owner check, against a real database",
  () => {
    it("signs an upload address for the owner of the institution", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedMediaFixture(tx);

        const grant = await requestLogoUploadUrl(tx, fixture.ownerA, fixture.institutionA.slug);

        expect(grant.fileKey.startsWith(`institution-logos/${fixture.institutionA.id}/`)).toBe(
          true,
        );
      });
    });

    it("refuses a staff member of the institution", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedMediaFixture(tx);

        await expect(
          requestLogoUploadUrl(tx, fixture.staffA, fixture.institutionA.slug),
        ).rejects.toMatchObject({ code: "forbidden", status: 403 });
        expect(generatePresignedPutUrl).not.toHaveBeenCalled();
      });
    });

    it("refuses a plain member of the institution", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedMediaFixture(tx);

        await expect(
          requestLogoUploadUrl(tx, fixture.memberA, fixture.institutionA.slug),
        ).rejects.toMatchObject({ code: "forbidden", status: 403 });
        expect(generatePresignedPutUrl).not.toHaveBeenCalled();
      });
    });

    it("refuses the owner of another institution", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedMediaFixture(tx);

        await expect(
          requestLogoUploadUrl(tx, fixture.ownerB, fixture.institutionA.slug),
        ).rejects.toMatchObject({ code: "forbidden", status: 403 });
        expect(generatePresignedPutUrl).not.toHaveBeenCalled();
      });
    });
  },
);
