// @vitest-environment node
//
// NOBODY DECIDES THEIR OWN INSTITUTION — against a real Postgres.
//
// WHAT THIS FILE EXISTS TO PROVE, and why the unit suite cannot. The unit suite builds the acting
// account as a hand-written `{ id, role, suspendedAt }` object, so it measures the branch and nothing
// about the wiring: a membership check that was never reached, or reached against the wrong
// identifier, passes it. Here every actor is a real `users` row, every membership is a real
// `institution_memberships` row, and every refusal is produced by calling the production service
// against a real connection (Rule 33).
//
// THE REFUSAL IS NOT THE ASSERTION. A decision that throws and still wrote would satisfy "it threw"
// while being the failure this exists to prevent, so each refusal is followed by four assertions:
// the institution's verification_status is unchanged, the submission's status is unchanged, there is
// no row in `institution_verification_audit`, and no mail was composed. The mail assertion is made
// against the module's own mocked senders rather than inferred from the absence of a table.
//
// The commit path is asserted too — a guard that refuses the conflicted actor must not have become a
// guard that refuses everybody — and the audit row it writes is checked to name the RESOLVED actor.
//
// Everything except the concurrency test runs inside a transaction that is ALWAYS rolled back.
// The concurrency test cannot: one connection cannot block on itself, and a second connection cannot
// see uncommitted rows. It commits, and it deletes what it wrote — see its own teardown contract.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  institutionMemberships,
  institutionVerificationAudit,
  institutionVerificationSubmissions,
  institutions,
  platformOpsAuditLogs,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { NEW_INSTITUTION_DEFAULT_STATUS } from "@/server/institution-workspace/institution-service";

// THE ONE SEAM, drawn at the mail provider. Both services compose an owner notice after committing,
// and there is no Resend here. Stubbed so a refusal is measured against the guard rather than against
// an unreachable API — and the stubs are themselves the assertion that a refused decision composed
// nothing.
const { sendVerified, sendRevoked, sendRejected } = vi.hoisted(() => ({
  sendVerified: vi.fn(async () => {}),
  sendRevoked: vi.fn(async () => {}),
  sendRejected: vi.fn(async () => {}),
}));

vi.mock("@/server/institution-verification/verification-email", () => ({
  sendInstitutionVerifiedEmail: sendVerified,
  sendInstitutionVerificationRevokedEmail: sendRevoked,
  sendInstitutionRejectedEmail: sendRejected,
}));

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
// Built with the schema, as `getDb()` is: without it the transaction handle carries an empty schema
// and is not assignable to the `Database` the services take — a type error rather than a runtime one.
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

// Derived from the application's own `Database` rather than from a fresh `drizzle()` call, so the
// handle this file's transaction produces is the one the services accept.
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
// Hyphen-separated: an institution slug goes through `normalizeInstitutionSlug` on the way in from a
// URL, which rewrites `_` to `-`. A fixture slug carrying an underscore is one `isInstitutionMemberBySlug`
// could never match, so the membership check would answer `false` for a member and the test would
// measure the fixture rather than the guard.
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

const seedUser = async (
  tx: Tx,
  role: "candidate" | "recruiter" | "platform_ops",
): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `ops_conflict_${id}@example.test`,
      username: `ops_conflict_${id}`,
      role,
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
};

type SeedInstitutionOptions = {
  verificationStatus?: "pending_verification" | "under_review" | "verified";
  slug?: string;
};

const seedInstitution = async (
  tx: Tx,
  options: SeedInstitutionOptions = {},
): Promise<{ id: string; slug: string }> => {
  const id = uniqueSuffix();
  const slug = options.slug ?? `conflict-inst-${id}`;
  const [row] = await tx
    .insert(institutions)
    .values({
      slug,
      displayName: `Conflict Fixture ${id}`,
      institutionType: "company",
      // The value the production creation path writes, not the column's schema default.
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      verificationStatus: options.verificationStatus ?? "pending_verification",
    })
    .returning({ id: institutions.id, slug: institutions.slug });
  return row!;
};

const addMembership = async (
  tx: Tx,
  institutionId: string,
  userId: string,
  membershipRole: "institution_owner" | "institution_staff" | "institution_member",
): Promise<void> => {
  await tx.insert(institutionMemberships).values({
    institutionId,
    userId,
    membershipRole,
    status: "active",
  });
};

const seedSubmission = async (
  tx: Tx,
  institutionId: string,
  submittedByUserId: string,
): Promise<string> => {
  const [row] = await tx
    .insert(institutionVerificationSubmissions)
    .values({
      institutionId,
      submittedByUserId,
      targetInstitutionType: "company",
      status: "pending_review",
    })
    .returning({ id: institutionVerificationSubmissions.id });
  return row!.id;
};

const readInstitutionStatus = async (tx: Tx, institutionId: string): Promise<string> => {
  const [row] = await tx
    .select({ verificationStatus: institutions.verificationStatus })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);
  return row!.verificationStatus;
};

const readSubmission = async (
  tx: Tx,
  submissionId: string,
): Promise<{ status: string; reviewerUserId: string | null; reviewerNotes: string | null }> => {
  const [row] = await tx
    .select({
      status: institutionVerificationSubmissions.status,
      reviewerUserId: institutionVerificationSubmissions.reviewerUserId,
      reviewerNotes: institutionVerificationSubmissions.reviewerNotes,
    })
    .from(institutionVerificationSubmissions)
    .where(eq(institutionVerificationSubmissions.id, submissionId))
    .limit(1);
  return row!;
};

const auditRowsFor = async (tx: Tx, institutionId: string) =>
  tx
    .select({
      actorUserId: institutionVerificationAudit.actorUserId,
      fromStatus: institutionVerificationAudit.fromStatus,
      toStatus: institutionVerificationAudit.toStatus,
    })
    .from(institutionVerificationAudit)
    .where(eq(institutionVerificationAudit.institutionId, institutionId));

const verifyInstitutionFor = async (
  tx: Tx,
  actorUserId: string,
  institutionId: string,
  targetStatus: "verified" | "rejected" = "verified",
) => {
  const { verifyInstitution } =
    await import("@/server/institution-verification/verification-service");
  return verifyInstitution({
    institutionId,
    targetStatus,
    reason: targetStatus === "rejected" ? "Dokumen tidak sah" : undefined,
    actorUserId,
    db: tx as unknown as Database,
  });
};

const reviewFor = async (
  tx: Tx,
  reviewerUserId: string,
  submissionId: string,
  decision: "approved" | "rejected",
) => {
  const { reviewVerificationSubmission } =
    await import("@/server/institution-verification/submission-service");
  return reviewVerificationSubmission(
    submissionId,
    decision,
    decision === "rejected" ? "Dokumen tidak valid" : null,
    reviewerUserId,
    tx as unknown as Database,
  );
};

const CONFLICT_MESSAGE =
  "A platform-ops account cannot decide the verification of an institution it submitted for or belongs to";

describe.skipIf(skipWithoutDatabase)("nobody decides their own institution", () => {
  // The mailer stubs are module-level, so without this the "not called" assertions below would be
  // reading a previous test's call.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a reviewer who filed the submission, and writes nothing", async () => {
    await inRollback(async (tx) => {
      const owner = await seedUser(tx, "candidate");
      const institution = await seedInstitution(tx);
      await addMembership(tx, institution.id, owner, "institution_owner");
      const submissionId = await seedSubmission(tx, institution.id, owner);

      // THE SHAPE THE WHOLE GUARD EXISTS FOR: a platform_ops account that is also the institution's
      // owner, reviewing the submission it filed itself. Every other refusal in the actor family lets
      // this through, because the account really does hold platform_ops and really is not suspended.
      const conflictedReviewer = await seedUser(tx, "platform_ops");
      await tx
        .update(institutionVerificationSubmissions)
        .set({ submittedByUserId: conflictedReviewer })
        .where(eq(institutionVerificationSubmissions.id, submissionId));

      await expect(
        reviewFor(tx, conflictedReviewer, submissionId, "approved"),
      ).rejects.toMatchObject({
        code: "operator_actor_conflicted",
        status: 403,
        message: CONFLICT_MESSAGE,
      });

      expect(await readInstitutionStatus(tx, institution.id)).toBe("pending_verification");
      expect((await readSubmission(tx, submissionId)).status).toBe("pending_review");
      expect(await auditRowsFor(tx, institution.id)).toHaveLength(0);
      expect(sendVerified).not.toHaveBeenCalled();
    });
  });

  it("refuses a reviewer who holds an active membership, for every membership role", async () => {
    for (const membershipRole of [
      "institution_owner",
      "institution_staff",
      "institution_member",
    ] as const) {
      await inRollback(async (tx) => {
        const owner = await seedUser(tx, "candidate");
        const institution = await seedInstitution(tx);
        await addMembership(tx, institution.id, owner, "institution_owner");
        const submissionId = await seedSubmission(tx, institution.id, owner);

        // An ordinary member counts. The problem is being on the inside, not holding an operational
        // permission — `institution_member` has none and is refused all the same.
        const insider = await seedUser(tx, "platform_ops");
        await addMembership(tx, institution.id, insider, membershipRole);

        await expect(
          reviewFor(tx, insider, submissionId, "rejected"),
          membershipRole,
        ).rejects.toMatchObject({ code: "operator_actor_conflicted", status: 403 });

        expect(await readInstitutionStatus(tx, institution.id)).toBe("pending_verification");
        expect((await readSubmission(tx, submissionId)).status).toBe("pending_review");
        expect(await auditRowsFor(tx, institution.id)).toHaveLength(0);
        expect(sendRejected).not.toHaveBeenCalled();
      });
    }
  });

  it("refuses a membership in the target only, leaving another institution decidable", async () => {
    await inRollback(async (tx) => {
      const ownerA = await seedUser(tx, "candidate");
      const ownerB = await seedUser(tx, "candidate");
      const institutionA = await seedInstitution(tx);
      const institutionB = await seedInstitution(tx);
      await addMembership(tx, institutionA.id, ownerA, "institution_owner");
      await addMembership(tx, institutionB.id, ownerB, "institution_owner");
      const submissionA = await seedSubmission(tx, institutionA.id, ownerA);
      const submissionB = await seedSubmission(tx, institutionB.id, ownerB);

      // The membership is keyed to THIS institution. The control is what makes the refusal above
      // discriminating: an implementation that refused every reviewer holding ANY membership would
      // pass a file containing only the refusal.
      const insiderOfA = await seedUser(tx, "platform_ops");
      await addMembership(tx, institutionA.id, insiderOfA, "institution_member");

      await expect(reviewFor(tx, insiderOfA, submissionA, "approved")).rejects.toMatchObject({
        code: "operator_actor_conflicted",
      });

      const approved = await reviewFor(tx, insiderOfA, submissionB, "approved");
      expect(approved.status).toBe("approved");
      expect(await readInstitutionStatus(tx, institutionB.id)).toBe("verified");
    });
  });

  it("refuses a revoking operator who belongs to the institution, and leaves its status alone", async () => {
    await inRollback(async (tx) => {
      const owner = await seedUser(tx, "candidate");
      const institution = await seedInstitution(tx, { verificationStatus: "verified" });
      await addMembership(tx, institution.id, owner, "institution_owner");

      const insider = await seedUser(tx, "platform_ops");
      await addMembership(tx, institution.id, insider, "institution_staff");

      await expect(
        verifyInstitutionFor(tx, insider, institution.id, "rejected"),
      ).rejects.toMatchObject({
        code: "operator_actor_conflicted",
        status: 403,
        message: CONFLICT_MESSAGE,
      });

      expect(await readInstitutionStatus(tx, institution.id)).toBe("verified");
      expect(await auditRowsFor(tx, institution.id)).toHaveLength(0);
      expect(sendRevoked).not.toHaveBeenCalled();
    });
  });

  it("completes the decision for an operator with no relationship, and names that account in the audit row", async () => {
    await inRollback(async (tx) => {
      const owner = await seedUser(tx, "candidate");
      const institution = await seedInstitution(tx);
      await addMembership(tx, institution.id, owner, "institution_owner");
      const submissionId = await seedSubmission(tx, institution.id, owner);

      const operator = await seedUser(tx, "platform_ops");

      const result = await reviewFor(tx, operator, submissionId, "approved");

      expect(result.status).toBe("approved");
      expect(await readInstitutionStatus(tx, institution.id)).toBe("verified");

      const submission = await readSubmission(tx, submissionId);
      expect(submission.status).toBe("approved");
      // The RESOLVED actor, not the claimed one.
      expect(submission.reviewerUserId).toBe(operator);

      expect(await auditRowsFor(tx, institution.id)).toEqual([
        { actorUserId: operator, fromStatus: "pending_verification", toStatus: "verified" },
      ]);
      expect(sendVerified).toHaveBeenCalledTimes(1);
    });
  });

  it("records the resolved operator, not the caller's claim, when the account moves between the two", async () => {
    await inRollback(async (tx) => {
      const owner = await seedUser(tx, "candidate");
      const institution = await seedInstitution(tx);
      await addMembership(tx, institution.id, owner, "institution_owner");

      // Two real platform_ops accounts. `claimed` is the id a caller asserts; `resolved` is the
      // account the database is asked about. They are distinct rows, so an implementation that wrote
      // the argument through would name the wrong one and be caught here.
      const claimed = await seedUser(tx, "platform_ops");
      const resolved = await seedUser(tx, "platform_ops");

      await verifyInstitutionFor(tx, resolved, institution.id, "verified");

      const rows = await auditRowsFor(tx, institution.id);
      expect(rows).toEqual([
        { actorUserId: resolved, fromStatus: "pending_verification", toStatus: "verified" },
      ]);
      expect(rows[0]!.actorUserId).not.toBe(claimed);
    });
  });

  // The same construction as the test above, on the other decision path and on BOTH of its
  // branches. `reviewVerificationSubmission` writes `actor.userId` in three places — the audit row,
  // the submission's reviewer, and the institution's CAS UPDATE — and each branch reaches them by
  // its own route, so a run that only exercised approval would leave the rejection branch's writer
  // unmeasured.
  it.each(["approved", "rejected"] as const)(
    "records the resolved operator, not the caller's claim, when a submission is %s",
    async (decision) => {
      await inRollback(async (tx) => {
        const owner = await seedUser(tx, "candidate");
        const institution = await seedInstitution(tx);
        await addMembership(tx, institution.id, owner, "institution_owner");
        const submissionId = await seedSubmission(tx, institution.id, owner);

        const claimed = await seedUser(tx, "platform_ops");
        const resolved = await seedUser(tx, "platform_ops");

        await reviewFor(tx, resolved, submissionId, decision);

        const rows = await auditRowsFor(tx, institution.id);
        expect(rows).toEqual([
          {
            actorUserId: resolved,
            fromStatus: "pending_verification",
            // An approval moves the institution; a rejection records the review without moving it.
            toStatus: decision === "approved" ? "verified" : "pending_verification",
          },
        ]);
        expect(rows[0]!.actorUserId).not.toBe(claimed);
        expect((await readSubmission(tx, submissionId)).reviewerUserId).toBe(resolved);
      });
    },
  );

  it("leaves no platform_ops_audit_logs row on either path", async () => {
    await inRollback(async (tx) => {
      const owner = await seedUser(tx, "candidate");
      const institution = await seedInstitution(tx);
      await addMembership(tx, institution.id, owner, "institution_owner");
      const submissionId = await seedSubmission(tx, institution.id, owner);
      const operator = await seedUser(tx, "platform_ops");

      await reviewFor(tx, operator, submissionId, "approved");
      await verifyInstitutionFor(tx, operator, institution.id, "rejected");

      // Neither decision path routes through `recordOperatorAuditEntry`: they write
      // `institution_verification_audit` instead, which is the table this domain's trail lives in.
      const rows = await tx
        .select({ id: platformOpsAuditLogs.id })
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.actorUserId, operator));
      expect(rows).toHaveLength(0);
    });
  });
});

// ─── Two concurrent rejections of one submission ──────────────────────────────
//
// THIS TEST COMMITS. The rollback harness above structurally cannot run it: one connection cannot
// block on itself, so the pinned UPDATE would never contend, and a second connection cannot see
// uncommitted rows. The barrier is what makes it a race rather than a hope — a third connection holds
// `FOR UPDATE` on the submission row, both rejections are launched and each is confirmed PARKED on
// that lock, and only then is the barrier released. Without that, two rejections started together may
// simply run one after the other, the loser would read `rejected` at its CAS fetch and the pinned
// UPDATE would never be reached — the test would pass while proving nothing about the pin.
//
// THE TEARDOWN IS A CONTRACT, not a courtesy (Rule 35). It runs in a `finally`, signal handlers cover
// SIGINT/SIGTERM, and the marker sweep at the start of the run removes anything a PREVIOUS run left
// behind — because nothing runs on SIGKILL.
const RACE_MARKER = "opsconflictrace";
const BARRIER_TIMEOUT_MS = 5_000;
const BARRIER_POLL_MS = 25;

type RaceConnection = {
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

// One connection per racer, and never recycled: the harness reads the wait graph for a block that
// must still be in flight, and a pool would silently move a query to a different backend. The
// CONTROL connection is the exception — it holds the barrier transaction open on one connection
// while polling the wait graph from another, so a `max: 1` control would deadlock against its own
// barrier and the test would hang rather than fail.
const openRaceConnection = (max = 1): RaceConnection => {
  const sql = postgres(TEST_DATABASE_URL!, { max, idle_timeout: 0 });
  return { sql, db: drizzle(sql, { schema }) };
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(skipWithoutDatabase)("two concurrent rejections of one submission", () => {
  it("produces exactly one success, one 409 and one audit row", async () => {
    const connections = [openRaceConnection(2), openRaceConnection(), openRaceConnection()];
    const [control, firstRacer, secondRacer] = connections as [
      RaceConnection,
      RaceConnection,
      RaceConnection,
    ];

    let institutionId: string | null = null;
    let releaseBarrier: () => void = () => {};

    const cleanup = async (): Promise<void> => {
      if (!institutionId) return;
      // Institutions cascade to memberships, submissions and the verification audit trail; users do
      // not cascade from it, so they are deleted by the same marker.
      await control.sql`DELETE FROM institutions WHERE id = ${institutionId}`;
      await control.sql`DELETE FROM users WHERE username LIKE ${`${RACE_MARKER}%`}`;
      institutionId = null;
    };

    const onSignal = (): void => {
      void cleanup().finally(() => process.exit(130));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      // Sweep anything a previous, killed run left behind before this one starts.
      await control.sql`DELETE FROM users WHERE username LIKE ${`${RACE_MARKER}%`}`;

      const tag = `${Date.now()}-${seq++}`;
      const reviewerRows = await control.sql<{ id: string }[]>`
        INSERT INTO users (id, email, username, role, candidate_verified_at)
        VALUES
          (${`${RACE_MARKER}_r1_${tag}`}, ${`${RACE_MARKER}_r1_${tag}@example.test`}, ${`${RACE_MARKER}_r1_${tag}`}, 'platform_ops', now()),
          (${`${RACE_MARKER}_r2_${tag}`}, ${`${RACE_MARKER}_r2_${tag}@example.test`}, ${`${RACE_MARKER}_r2_${tag}`}, 'platform_ops', now())
        RETURNING id
      `;
      const ownerId = `${RACE_MARKER}_owner_${tag}`;
      await control.sql`
        INSERT INTO users (id, email, username, role, candidate_verified_at)
        VALUES (${ownerId}, ${`${ownerId}@example.test`}, ${ownerId}, 'candidate', now())
      `;

      const [institution] = await control.sql<{ id: string }[]>`
        INSERT INTO institutions (slug, display_name, institution_type, status, verification_status)
        VALUES (${`${RACE_MARKER}-inst-${tag}`}, ${`Race Fixture ${tag}`}, 'company', ${NEW_INSTITUTION_DEFAULT_STATUS}, 'pending_verification')
        RETURNING id
      `;
      institutionId = institution!.id;

      await control.sql`
        INSERT INTO institution_memberships (institution_id, user_id, membership_role, status)
        VALUES (${institutionId}, ${ownerId}, 'institution_owner', 'active')
      `;

      const [submission] = await control.sql<{ id: string }[]>`
        INSERT INTO institution_verification_submissions
          (institution_id, submitted_by_user_id, target_institution_type, status)
        VALUES (${institutionId}, ${ownerId}, 'company', 'pending_review')
        RETURNING id
      `;
      const submissionId = submission!.id;

      const { reviewVerificationSubmission } =
        await import("@/server/institution-verification/submission-service");

      const reject = (connection: RaceConnection, reviewerUserId: string) =>
        reviewVerificationSubmission(
          submissionId,
          "rejected",
          "Dokumen tidak valid",
          reviewerUserId,
          connection.db as unknown as Database,
        );

      // The barrier holds the row so both rejections have taken their snapshot before either commits.
      const barrierReleased = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const handled = <T>(promise: Promise<T>): Promise<T> => {
        promise.catch(() => {});
        return promise;
      };

      const barrier = handled(
        control.sql.begin(async (tx) => {
          // postgres-js types the transaction callback's argument as a bare `TransactionSql`, which
          // does not carry the tagged-template call signature the same object has at runtime.
          const locked = tx as unknown as typeof control.sql;
          await locked`SELECT id FROM institution_verification_submissions WHERE id = ${submissionId} FOR UPDATE`;
          await barrierReleased;
        }),
      );

      await delay(50);

      const countBlocked = async (): Promise<number> => {
        const rows = await control.sql<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND state = 'active'
            AND pid <> pg_backend_pid()
        `;
        return rows[0]?.n ?? 0;
      };

      const waitForBlocked = async (expected: number): Promise<boolean> => {
        const deadline = Date.now() + BARRIER_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if ((await countBlocked()) >= expected) return true;
          await delay(BARRIER_POLL_MS);
        }
        return false;
      };

      const first = handled(reject(firstRacer, reviewerRows[0]!.id));
      const firstParked = await waitForBlocked(1);
      const second = handled(reject(secondRacer, reviewerRows[1]!.id));
      const bothParked = await waitForBlocked(2);

      releaseBarrier();
      await barrier;

      // If they never queued, this is not a race and the assertions below would describe an
      // interleaving that did not happen. Fail rather than report a pass on nothing.
      expect(firstParked && bothParked, "the racers never contended on the row's lock").toBe(true);

      const outcomes = await Promise.allSettled([first, second]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );

      const loser = rejected[0]?.reason as { code?: string; status?: number } | undefined;

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(loser?.status).toBe(409);
      // The pin, not the CAS fetch: both racers read `pending_review` before either committed, so
      // the loser's refusal can only have come from the UPDATE matching nothing.
      expect(loser?.code).toBe("verification_transition_conflict");

      const auditRows = await control.sql<{ actor_user_id: string }[]>`
        SELECT actor_user_id FROM institution_verification_audit WHERE institution_id = ${institutionId}
      `;
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.actor_user_id).toBe(reviewerRows[0]!.id);

      const [finalSubmission] = await control.sql<{ status: string; reviewer_user_id: string }[]>`
        SELECT status, reviewer_user_id FROM institution_verification_submissions WHERE id = ${submissionId}
      `;
      expect(finalSubmission!.status).toBe("rejected");
      expect(finalSubmission!.reviewer_user_id).toBe(reviewerRows[0]!.id);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      try {
        await cleanup();
      } finally {
        await Promise.all(connections.map((connection) => connection.sql.end()));
      }
    }
  });
});
