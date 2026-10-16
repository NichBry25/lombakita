// @vitest-environment node
//
// NOBODY DECIDES THEIR OWN RECRUITER APPLICATION (LAUNCH-D136), against a real Postgres.
//
// The unit suite builds the acting account and the submission as hand-written rows, so it measures
// the branch and nothing about the wiring. Here the operator is a real `users` row holding a real
// `recruiter_verification_submissions` row, and every refusal is produced by calling the production
// service against a real connection (Rule 33).
//
// THE REFUSAL IS NOT THE ASSERTION. A review that throws and still flipped the row would satisfy "it
// threw" while being the failure this exists to prevent, so each refusal is followed by the state
// assertions: the submission's status and resubmission bar are unchanged, the tier is unchanged, and
// no `platform_ops_audit_logs` row names the account.
//
// Every test runs inside a transaction that is ALWAYS rolled back. Nothing here is committed.

import { afterAll, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { platformOpsAuditLogs, recruiterVerificationSubmissions, users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

// The seams drawn at the two systems a refusal must not reach: the object store the post-review
// sweep lists, and the queue the rejection notice goes to.
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: vi.fn().mockReturnValue(false),
  generatePresignedPutUrl: vi.fn(),
  generatePresignedGetUrl: vi.fn(),
  headObject: vi.fn(),
  readObjectHead: vi.fn(),
  deleteObject: vi.fn(),
  listObjects: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/server/async/enqueue", () => ({
  enqueueRecruiterVerificationRejected: vi.fn().mockResolvedValue(undefined),
}));

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

const seedOperator = async (tx: Tx): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `ops_recruiter_${id}@example.test`,
      username: `ops_recruiter_${id}`,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedSubmission = async (
  tx: Tx,
  userId: string,
  state: { status: "pending_review" | "rejected"; resubmissionAllowed?: boolean },
): Promise<string> => {
  const [row] = await tx
    .insert(recruiterVerificationSubmissions)
    .values({
      userId,
      fullName: "Operator Fixture",
      mobileNumber: "+620000000000",
      status: state.status,
      resubmissionAllowed: state.resubmissionAllowed ?? true,
    })
    .returning({ id: recruiterVerificationSubmissions.id });
  return row!.id;
};

const readSubmission = async (tx: Tx, submissionId: string) => {
  const [row] = await tx
    .select({
      status: recruiterVerificationSubmissions.status,
      resubmissionAllowed: recruiterVerificationSubmissions.resubmissionAllowed,
    })
    .from(recruiterVerificationSubmissions)
    .where(eq(recruiterVerificationSubmissions.id, submissionId))
    .limit(1);
  return row!;
};

const readTier = async (tx: Tx, userId: string): Promise<string> => {
  const [row] = await tx
    .select({ tier: users.recruiterVerificationTier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row!.tier;
};

const auditRowsAbout = (tx: Tx, userId: string) =>
  tx.select().from(platformOpsAuditLogs).where(eq(platformOpsAuditLogs.targetUserId, userId));

describe.skipIf(skipWithoutDatabase)(
  "operator recruiter-verification writers, real database",
  () => {
    it("refuses an operator approving their own pending submission, and changes nothing", async () => {
      await inRollback(async (tx) => {
        const { reviewRecruiterVerification } = await import("./recruiter-verification-service");
        const operatorId = await seedOperator(tx);
        const submissionId = await seedSubmission(tx, operatorId, { status: "pending_review" });

        await expect(
          reviewRecruiterVerification(operatorId, submissionId, "approve", null, { db: tx }),
        ).rejects.toMatchObject({ code: "operator_actor_is_target", status: 403 });

        expect((await readSubmission(tx, submissionId)).status).toBe("pending_review");
        expect(await readTier(tx, operatorId)).toBe("unverified");
        expect(await auditRowsAbout(tx, operatorId)).toHaveLength(0);
      });
    });

    it("refuses an operator changing the resubmission bar on their own rejected submission", async () => {
      await inRollback(async (tx) => {
        const { setRecruiterResubmissionAllowed } =
          await import("./recruiter-verification-service");
        const operatorId = await seedOperator(tx);
        const submissionId = await seedSubmission(tx, operatorId, {
          status: "rejected",
          resubmissionAllowed: true,
        });

        await expect(
          setRecruiterResubmissionAllowed(operatorId, submissionId, false, tx),
        ).rejects.toMatchObject({ code: "operator_actor_is_target", status: 403 });

        expect((await readSubmission(tx, submissionId)).resubmissionAllowed).toBe(true);
        expect(await auditRowsAbout(tx, operatorId)).toHaveLength(0);
      });
    });

    it("still lets a different operator change the bar, and audits the resolved actor", async () => {
      await inRollback(async (tx) => {
        const { setRecruiterResubmissionAllowed } =
          await import("./recruiter-verification-service");
        const ownerOperatorId = await seedOperator(tx);
        const reviewerId = await seedOperator(tx);
        const submissionId = await seedSubmission(tx, ownerOperatorId, {
          status: "rejected",
          resubmissionAllowed: true,
        });

        await setRecruiterResubmissionAllowed(reviewerId, submissionId, false, tx);

        expect((await readSubmission(tx, submissionId)).resubmissionAllowed).toBe(false);
        const audit = await auditRowsAbout(tx, ownerOperatorId);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actorUserId: reviewerId,
          eventType: "recruiter_verification.resubmission_blocked",
        });
      });
    });
  },
);
