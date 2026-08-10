/**
 * INST-VERIF-T2 and REVISION-T2 — live proof of the two compare-and-set races in the verification
 * surfaces. These are NOT lock races: there is no advisory lock, the guard is a WHERE clause pinning
 * the status the decision was made against, and the loser must be told its snapshot went stale
 * rather than silently overwriting the winner.
 *
 * INST-VERIF-T2: platform ops revokes an institution's verification (`verifyInstitution`) at the
 * same moment another reviewer approves its pending submission (`reviewVerificationSubmission`).
 * Both paths were reconciled onto one transition set, and both CAS on `verification_status`. The
 * loser must get `verification_transition_conflict` (409) — a code distinct from
 * `verification_invalid_transition` precisely because the request was well-formed.
 *
 * REVISION-T2: a recruiter withdraws their queued submission (CAS `pending_review -> draft`) as a
 * reviewer records a verdict on it. Whichever commits first wins; the other must not apply a verdict
 * to a withdrawn submission, nor withdraw one already decided.
 *
 * THE BARRIER. Both races need the two transactions to have read the row BEFORE either commits;
 * left to chance they often run sequentially and prove nothing while passing. A third connection
 * holds `SELECT ... FOR UPDATE` on the contended row, so both racers reach their UPDATE and block
 * there — plain SELECTs are not blocked by a row lock, so each has already taken its snapshot. When
 * the barrier releases, one UPDATE wins the row and the other re-evaluates its WHERE against the
 * committed new version and matches nothing. If the racers cannot be observed blocking, the check
 * FAILS rather than falling through to a pass.
 *
 * Usage: node --import tsx scripts/concurrency/verification-cas-races.ts
 * Exit code: 0 when every assertion holds; 1 on a lost update or a wrong error.
 */

import {
  assertReadCommitted,
  createChecker,
  describeOutcome,
  finish,
  oneRow,
  openPool,
  settleAll,
  type RaceOutcome,
} from "./harness";
import { randomUUID } from "crypto";

const ITERATIONS = 5;
const BARRIER_WAIT_TIMEOUT_MS = 5000;
const BARRIER_POLL_INTERVAL_MS = 25;

const main = async (): Promise<void> => {
  const { client, db } = await openPool();
  const { verifyInstitution } = await import(
    "@/server/institution-verification/verification-service"
  );
  const { reviewVerificationSubmission } = await import(
    "@/server/institution-verification/submission-service"
  );
  const { reviewRecruiterVerification, withdrawRecruiterVerification } = await import(
    "@/server/recruiter-verification/recruiter-verification-service"
  );

  const { check, failureCount } = createChecker();
  const createdUserIds: string[] = [];
  const createdInstitutionIds: string[] = [];

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Counts backends parked on a lock. Both racers blocking is the observable proof that each has
  // taken its snapshot and is now contending for the row.
  const countBlockedBackends = async (): Promise<number> => {
    const rows = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND state = 'active'
        AND pid <> pg_backend_pid()
    `;
    return rows[0]?.n ?? 0;
  };

  const waitForBlockedRacers = async (expected: number): Promise<boolean> => {
    const deadline = Date.now() + BARRIER_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await countBlockedBackends()) >= expected) return true;
      await delay(BARRIER_POLL_INTERVAL_MS);
    }
    return false;
  };

  // Runs both operations against a row already locked by a third connection, then releases the
  // barrier once both are provably blocked on it.
  //
  // The racers are started STAGGERED — the second only once the first is observed waiting on the
  // lock — because Postgres grants a contended row lock in arrival order, and the two operations do
  // different amounts of work before their UPDATE. Starting them together always hands the win to
  // whichever reaches the lock sooner, so `first` would silently mean "whoever is quicker" instead
  // of what the caller asked for, and one of the two legal outcomes would never be exercised.
  //
  // `barrierHeld === false` means the race never happened; the caller must fail the check rather
  // than report a pass on an interleaving that did not occur.
  const raceBehindRowLock = async (
    lockRow: (tx: typeof client) => Promise<unknown>,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ): Promise<{ outcome: RaceOutcome; barrierHeld: boolean }> => {
    let releaseBarrier: () => void = () => {};
    const barrierReleased = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    // Every promise here is created and only awaited several `await`s later, so each needs a
    // handler attached AT CREATION. A promise that rejects while nothing is listening is an
    // unhandled rejection, which Node answers by killing the process — skipping the `finally` that
    // deletes this script's seed rows. `.catch(() => {})` marks the rejection handled without
    // consuming it: the later `await` still throws and still reaches the real handler.
    const handled = <T>(promise: Promise<T>): Promise<T> => {
      promise.catch(() => {});
      return promise;
    };

    const barrier = handled(
      client.begin(async (tx) => {
        await lockRow(tx as unknown as typeof client);
        await barrierReleased;
      }),
    );

    // Give the barrier transaction time to take the row lock before the racers start.
    await delay(50);

    const firstRacer = handled(first());
    const firstQueued = await waitForBlockedRacers(1);
    const secondRacer = handled(second());
    const bothQueued = await waitForBlockedRacers(2);

    releaseBarrier?.();
    await barrier;

    return {
      outcome: await settleAll([firstRacer, secondRacer]),
      barrierHeld: firstQueued && bothQueued,
    };
  };

  const seedUser = async (
    prefix: string,
    columns: { role?: string; recruiterTier?: string } = {},
  ): Promise<string> => {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    const role = columns.role ?? "candidate";
    const tier = columns.recruiterTier ?? "unverified";
    await client`
      INSERT INTO users (id, email, username, role, candidate_verified_at, recruiter_verification_tier, email_verified)
      VALUES (${id}, ${`${prefix}_${tag}@example.test`}, ${`${prefix}_${tag}`}, ${role}, now(), ${tier}, now())
    `;
    createdUserIds.push(id);
    return id;
  };

  // ---- INST-VERIF-T2 -------------------------------------------------------

  const runInstitutionRevokeVersusApprove = async (): Promise<void> => {
    console.log(
      `\n[inst-verif] ${ITERATIONS} iterations, revoke vs approve on one institution (CAS)`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const ownerId = await seedUser("casinst_own");
      const reviewerId = await seedUser("casinst_ops", { role: "platform_ops" });
      const tag = ownerId.slice(0, 8);

      const institution = oneRow(await client<{ id: string }[]>`
        INSERT INTO institutions (display_name, slug, institution_type, verification_status)
        VALUES (${`CAS Inst ${tag}`}, ${`casinst-${tag}`}, 'company', 'under_review')
        RETURNING id
      `, "institution");
      createdInstitutionIds.push(institution.id);

      await client`
        INSERT INTO institution_memberships (institution_id, user_id, membership_role, status)
        VALUES (${institution.id}, ${ownerId}, 'institution_owner', 'active')
      `;

      const submission = oneRow(await client<{ id: string }[]>`
        INSERT INTO institution_verification_submissions
          (institution_id, submitted_by_user_id, target_institution_type, status)
        VALUES (${institution.id}, ${ownerId}, 'company', 'pending_review')
        RETURNING id
      `, "submission");

      const approve = () =>
        reviewVerificationSubmission(
          submission.id,
          "approved",
          "Dokumen lengkap",
          reviewerId,
          "platform_ops",
          db,
        );
      const revoke = () =>
        verifyInstitution({
          institutionId: institution.id,
          targetStatus: "rejected",
          reason: "Dokumen tidak sah",
          actorUserId: reviewerId,
          actorRole: "platform_ops",
          db,
        });

      // Alternating which racer takes the lock first exercises BOTH outcomes — an approval refused
      // by a revocation, and a revocation refused by an approval — rather than proving one
      // direction five times.
      const approveFirst = i % 2 === 0;
      const { outcome, barrierHeld } = await raceBehindRowLock(
        (tx) => tx`SELECT id FROM institutions WHERE id = ${institution.id} FOR UPDATE`,
        approveFirst ? approve : revoke,
        approveFirst ? revoke : approve,
      );
      const expectedFinalStatus = approveFirst ? "verified" : "rejected";

      const finalRow = oneRow(await client<{ verification_status: string }[]>`
        SELECT verification_status FROM institutions WHERE id = ${institution.id}
      `, "finalRow");
      const auditRows = await client<{ from_status: string; to_status: string }[]>`
        SELECT from_status, to_status FROM institution_verification_audit
        WHERE institution_id = ${institution.id}
        ORDER BY created_at ASC
      `;

      // Exactly one decision may land from a shared snapshot, and the single audit row must
      // describe the transition that actually happened.
      const auditMatchesReality =
        auditRows.length === 1 &&
        auditRows[0]?.from_status === "under_review" &&
        auditRows[0]?.to_status === finalRow.verification_status;

      check(
        barrierHeld &&
          outcome.ok === 1 &&
          outcome.failCodes.length === 1 &&
          outcome.failCodes[0] === "verification_transition_conflict" &&
          outcome.failStatuses[0] === 409 &&
          outcome.other.length === 0 &&
          finalRow.verification_status === expectedFinalStatus &&
          auditMatchesReality,
        `iter ${i} (${approveFirst ? "approve first" : "revoke first"}): ${describeOutcome(outcome)} barrier=${barrierHeld} final=${finalRow.verification_status} audit=[${auditRows.map((row) => `${row.from_status}->${row.to_status}`).join(",")}]` +
          ` [want: barrier=true ok=1 loser=verification_transition_conflict(409) final=${expectedFinalStatus} exactly one audit row matching it]`,
      );
    }
  };

  // ---- REVISION-T2 ---------------------------------------------------------

  const runWithdrawVersusVerdict = async (): Promise<void> => {
    console.log(
      `\n[revision] ${ITERATIONS} iterations, applicant withdraw vs reviewer verdict (CAS)`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const applicantId = await seedUser("casrev_app", { recruiterTier: "minimal" });
      const reviewerId = await seedUser("casrev_ops", { role: "platform_ops" });

      const submission = oneRow(await client<{ id: string }[]>`
        INSERT INTO recruiter_verification_submissions (user_id, full_name, mobile_number, status)
        VALUES (${applicantId}, 'Uji Balapan', '+628100000000', 'pending_review')
        RETURNING id
      `, "submission");

      const withdraw = () => withdrawRecruiterVerification(applicantId, db);
      const approve = () =>
        reviewRecruiterVerification(reviewerId, submission.id, "approve", null, { db });

      // Alternating exercises both legal endings — the applicant pulling the submission out from
      // under a verdict, and a verdict landing before the withdrawal.
      const withdrawFirst = i % 2 === 0;
      const { outcome, barrierHeld } = await raceBehindRowLock(
        (tx) =>
          tx`SELECT id FROM recruiter_verification_submissions WHERE id = ${submission.id} FOR UPDATE`,
        withdrawFirst ? withdraw : approve,
        withdrawFirst ? approve : withdraw,
      );

      const finalRow = oneRow(await client<{
        status: string;
        reviewer_user_id: string | null;
        reviewed_at: Date | null;
      }[]>`
        SELECT status, reviewer_user_id, reviewed_at
        FROM recruiter_verification_submissions WHERE id = ${submission.id}
      `, "finalRow");
      const applicant = oneRow(await client<{ recruiter_verification_tier: string }[]>`
        SELECT recruiter_verification_tier FROM users WHERE id = ${applicantId}
      `, "applicant");

      // The two legal end states. A withdrawn submission must carry no verdict and must not have
      // elevated the applicant; an approved one must carry its reviewer.
      const withdrawnCleanly =
        finalRow.status === "draft" &&
        finalRow.reviewer_user_id === null &&
        finalRow.reviewed_at === null &&
        applicant.recruiter_verification_tier === "minimal";
      const approvedCleanly =
        finalRow.status === "approved" &&
        finalRow.reviewer_user_id === reviewerId &&
        applicant.recruiter_verification_tier === "elevated";

      const loserCode = outcome.failCodes[0];
      const loserIsExpected =
        loserCode === "recruiter_verification_not_found" ||
        loserCode === "recruiter_verification_already_reviewed";

      check(
        barrierHeld &&
          outcome.ok === 1 &&
          outcome.failCodes.length === 1 &&
          loserIsExpected &&
          outcome.other.length === 0 &&
          (withdrawFirst ? withdrawnCleanly : approvedCleanly),
        `iter ${i} (${withdrawFirst ? "withdraw first" : "verdict first"}): ${describeOutcome(outcome)} barrier=${barrierHeld} final=${finalRow.status} reviewer=${finalRow.reviewer_user_id ? "set" : "null"} tier=${applicant.recruiter_verification_tier}` +
          ` [want: barrier=true ok=1, loser refused, end state a clean ${withdrawFirst ? "draft" : "approval"}]`,
      );
    }
  };

  const cleanup = async (): Promise<void> => {
    if (createdInstitutionIds.length > 0) {
      await client`DELETE FROM institutions WHERE id = ANY(${client.array(createdInstitutionIds)})`;
    }
    if (createdUserIds.length > 0) {
      await client`DELETE FROM platform_ops_audit_logs WHERE actor_user_id = ANY(${client.array(createdUserIds)})`;
      await client`DELETE FROM users WHERE id = ANY(${client.array(createdUserIds)})`;
    }
    console.log(
      `\nCleaned up ${createdUserIds.length} seeded users and ${createdInstitutionIds.length} institutions.`,
    );
  };

  try {
    await assertReadCommitted(client);
    await runInstitutionRevokeVersusApprove();
    await runWithdrawVersusVerdict();
  } finally {
    await cleanup();
    await client.end();
  }

  finish(failureCount(), "INST-VERIF-T2 + REVISION-T2");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
