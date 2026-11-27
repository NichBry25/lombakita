// @vitest-environment node

// The account sweep of the staff raise, against real rows in a rolled-back transaction. The raise
// runs through its real service. The rows it reads are planted: no path writes an older host
// request any more, and opening and turning down a host check needs a publish press on a
// publishable draft, which host-check-decision-db.integration.test.ts drives.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn<(prefix: string) => Promise<unknown[]>>().mockResolvedValue([]),
  deleteObject: vi.fn(),
  enqueueApproved: vi.fn<(input: unknown) => Promise<object>>().mockResolvedValue({}),
}));

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => true,
  listObjects: mocks.listObjects,
  deleteObject: mocks.deleteObject,
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, enqueueRecruiterVerificationApproved: mocks.enqueueApproved };
});

import { elevateRecruiterTier } from "@/server/recruiter-tier/recruiter-tier-service";

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
  mocks.listObjects.mockClear();
  mocks.deleteObject.mockClear();
  mocks.enqueueApproved.mockClear();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CONFIRMED_AT = new Date("2026-01-01T00:00:00Z");

// Planted directly: the operator the raise route resolves from the session.
const plantOperator = async (tx: Database, suffix: string): Promise<string> => {
  const [row] = await tx
    .insert(schema.users)
    .values({
      email: `ops.${suffix}@example.test`,
      username: `ops_${suffix}`,
      role: "platform_ops",
      emailVerified: CONFIRMED_AT,
      candidateVerifiedAt: CONFIRMED_AT,
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No operator row");
  return row.id;
};

// Planted directly: a host a staff raise can reach, because the host step that creates one needs a
// sign-up this file does not drive.
const plantHost = async (tx: Database, label: string, suffix: string): Promise<string> => {
  const [row] = await tx
    .insert(schema.users)
    .values({
      email: `${label}.${suffix}@example.test`,
      username: `${label}_${suffix}`,
      role: "recruiter",
      emailVerified: CONFIRMED_AT,
      candidateVerifiedAt: CONFIRMED_AT,
      recruiterVerifiedAt: CONFIRMED_AT,
      recruiterVerificationTier: "minimal",
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No host row");
  return row.id;
};

// Planted directly: the draft a host check names, in a workspace the host owns.
const plantDraftOf = async (tx: Database, hostId: string, suffix: string): Promise<string> => {
  const [institution] = await tx
    .insert(schema.institutions)
    .values({
      slug: `sweep-inst-${suffix}`,
      displayName: "Sweep Workspace",
      institutionType: "personal",
    })
    .returning({ id: schema.institutions.id });
  if (!institution) throw new Error("No institution row");
  await tx.insert(schema.institutionMemberships).values({
    institutionId: institution.id,
    userId: hostId,
    membershipRole: "institution_owner",
    status: "active",
  });
  const [draft] = await tx
    .insert(schema.competitions)
    .values({
      institutionId: institution.id,
      createdByUserId: hostId,
      status: "draft",
      title: "Draf Sweep",
      slug: `draf-sweep-${suffix}`,
    })
    .returning({ id: schema.competitions.id });
  if (!draft) throw new Error("No draft row");
  return draft.id;
};

// Planted directly: an older host request, as the request flow wrote it before host checks.
const plantOlderRejectedRequest = async (tx: Database, hostId: string): Promise<string> => {
  const now = Date.now();
  const [row] = await tx
    .insert(schema.recruiterVerificationSubmissions)
    .values({
      userId: hostId,
      competitionId: null,
      fullName: "Rina Pratama",
      mobileNumber: "0812345678",
      status: "rejected",
      submittedAt: new Date(now - 10 * DAY),
      reviewedAt: new Date(now - 9 * DAY),
    })
    .returning({ id: schema.recruiterVerificationSubmissions.id });
  if (!row) throw new Error("No older request row");
  return row.id;
};

// Planted directly: a host check a staff turn-down closed, which only a publish press and a staff
// decision write together.
const plantTurnedDownHostCheck = async (
  tx: Database,
  hostId: string,
  competitionId: string,
): Promise<string> => {
  const now = Date.now();
  const [row] = await tx
    .insert(schema.recruiterVerificationSubmissions)
    .values({
      userId: hostId,
      competitionId,
      fullName: "Rina Pratama",
      mobileNumber: "0812345678",
      status: "rejected",
      guidelineItem: "kontak-nyata",
      rejectionReason: "Kontak penyelenggara tidak dapat dihubungi.",
      submittedAt: new Date(now - DAY),
      reviewedAt: new Date(now - HOUR),
    })
    .returning({ id: schema.recruiterVerificationSubmissions.id });
  if (!row) throw new Error("No host check row");
  return row.id;
};

describe.skipIf(skipWithoutDatabase)("the account sweep of the staff raise (rolled back)", () => {
  it("sweeps the older host request of the account and never its newer turned-down host check", async () => {
    await inRollback(async (tx) => {
      const suffix = randomUUID().slice(0, 8);
      const operatorId = await plantOperator(tx, suffix);
      const hostA = await plantHost(tx, "host.a", suffix);
      const draftId = await plantDraftOf(tx, hostA, suffix);
      const olderRequestId = await plantOlderRejectedRequest(tx, hostA);
      await plantTurnedDownHostCheck(tx, hostA, draftId);

      const result = await elevateRecruiterTier(operatorId, hostA, tx);

      expect(result.changed).toBe(true);
      expect(mocks.listObjects).toHaveBeenCalledTimes(1);
      expect(mocks.listObjects).toHaveBeenCalledWith(
        `recruiter-verification/${hostA}/${olderRequestId}/`,
      );
    });
  });

  it("sweeps nothing for an account whose only rejected row is a host check", async () => {
    await inRollback(async (tx) => {
      const suffix = randomUUID().slice(0, 8);
      const operatorId = await plantOperator(tx, suffix);
      const hostB = await plantHost(tx, "host.b", suffix);
      const draftId = await plantDraftOf(tx, hostB, suffix);
      await plantTurnedDownHostCheck(tx, hostB, draftId);

      const result = await elevateRecruiterTier(operatorId, hostB, tx);

      expect(result.changed).toBe(true);
      expect(mocks.listObjects).not.toHaveBeenCalled();
    });
  });
});
