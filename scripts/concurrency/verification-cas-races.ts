/**
 * INST-VERIF-T2 and HOST-CHECK-T2 — live proof of the two compare-and-set races in the verification
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
 * HOST-CHECK-T2: two staff members decide one host check at the same moment, one approving it and
 * one turning it down (`decideHostCheck`). Both compare-and-set on the check's `pending_review`
 * status. Exactly one decision lands, the loser gets `host_check_already_decided` (409), and the
 * tier and the one decision audit row match the winner.
 *
 * THE BARRIER. Both races need the two transactions to have read the row BEFORE either commits;
 * left to chance they often run sequentially and prove nothing while passing. A third connection
 * holds `SELECT ... FOR UPDATE` on the contended row, so both racers reach their UPDATE and block
 * there — plain SELECTs are not blocked by a row lock, so each has already taken its snapshot. When
 * the barrier releases, one UPDATE wins the row and the other re-evaluates its WHERE against the
 * committed new version and matches nothing. If the racers cannot be observed blocking, the check
 * FAILS rather than falling through to a pass.
 *
 * In HOST-CHECK-T2 the second racer parks one step earlier, on the host's users row that the first
 * racer locks before its UPDATE. Once the first commits, the second's UPDATE reads the check again,
 * so the compare-and-set on its status still decides.
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
  const { verifyInstitution } =
    await import("@/server/institution-verification/verification-service");
  const { reviewVerificationSubmission } =
    await import("@/server/institution-verification/submission-service");
  const { decideHostCheck } = await import("@/server/host-trust/host-check-decision-service");

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
    columns: { role?: string; recruiterTier?: string; hostStep?: boolean } = {},
  ): Promise<string> => {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    const role = columns.role ?? "candidate";
    const tier = columns.recruiterTier ?? "unverified";
    const hostStep = columns.hostStep ?? false;
    await client`
      INSERT INTO users (id, email, username, role, candidate_verified_at, recruiter_verification_tier, email_verified, recruiter_verified_at)
      VALUES (${id}, ${`${prefix}_${tag}@example.test`}, ${`${prefix}_${tag}`}, ${role}, now(), ${tier}, now(), CASE WHEN ${hostStep}::boolean THEN now() ELSE NULL END)
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

      const institution = oneRow(
        await client<{ id: string }[]>`
        INSERT INTO institutions (display_name, slug, institution_type, verification_status)
        VALUES (${`CAS Inst ${tag}`}, ${`casinst-${tag}`}, 'company', 'under_review')
        RETURNING id
      `,
        "institution",
      );
      createdInstitutionIds.push(institution.id);

      await client`
        INSERT INTO institution_memberships (institution_id, user_id, membership_role, status)
        VALUES (${institution.id}, ${ownerId}, 'institution_owner', 'active')
      `;

      const submission = oneRow(
        await client<{ id: string }[]>`
        INSERT INTO institution_verification_submissions
          (institution_id, submitted_by_user_id, target_institution_type, status)
        VALUES (${institution.id}, ${ownerId}, 'company', 'pending_review')
        RETURNING id
      `,
        "submission",
      );

      const approve = () =>
        reviewVerificationSubmission(submission.id, "approved", "Dokumen lengkap", reviewerId, db);
      const revoke = () =>
        verifyInstitution({
          institutionId: institution.id,
          targetStatus: "rejected",
          reason: "Dokumen tidak sah",
          actorUserId: reviewerId,
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

      const finalRow = oneRow(
        await client<{ verification_status: string; tick_path: string | null }[]>`
        SELECT verification_status, tick_path FROM institutions WHERE id = ${institution.id}
      `,
        "finalRow",
      );
      const expectedTickPath = expectedFinalStatus === "verified" ? "documents" : null;
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
          finalRow.tick_path === expectedTickPath &&
          auditMatchesReality,
        `iter ${i} (${approveFirst ? "approve first" : "revoke first"}): ${describeOutcome(outcome)} barrier=${barrierHeld} final=${finalRow.verification_status} tick=${finalRow.tick_path} audit=[${auditRows.map((row) => `${row.from_status}->${row.to_status}`).join(",")}]` +
          ` [want: barrier=true ok=1 loser=verification_transition_conflict(409) final=${expectedFinalStatus} tick_path=documents when verified, null when rejected exactly one audit row matching it]`,
      );
    }
  };

  // ---- HOST-CHECK-T2 -------------------------------------------------------

  // Two staff members decide one host check at once. Alternating which takes the lock first exercises both endings, an approval refused by a turn-down and a turn-down refused by an approval.
  const runApproveVersusTurnDown = async (): Promise<void> => {
    console.log(
      `\n[host-check] ${ITERATIONS} iterations, staff approve vs staff turn-down on one host check (CAS)`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const hostId = await seedUser("cashc_host", {
        role: "recruiter",
        recruiterTier: "minimal",
        hostStep: true,
      });
      const approverId = await seedUser("cashc_ops_a", { role: "platform_ops" });
      const turnDownerId = await seedUser("cashc_ops_b", { role: "platform_ops" });
      const tag = hostId.slice(0, 8);

      const institution = oneRow(
        await client<{ id: string }[]>`
        INSERT INTO institutions (display_name, slug, institution_type)
        VALUES (${`CAS Host ${tag}`}, ${`cashc-${tag}`}, 'personal')
        RETURNING id
      `,
        "institution",
      );
      createdInstitutionIds.push(institution.id);

      await client`
        INSERT INTO institution_memberships (institution_id, user_id, membership_role, status)
        VALUES (${institution.id}, ${hostId}, 'institution_owner', 'active')
      `;

      const draft = oneRow(
        await client<{ id: string }[]>`
        INSERT INTO competitions (institution_id, created_by_user_id, slug, title, status)
        VALUES (${institution.id}, ${hostId}, ${`cashc-comp-${tag}`}, ${`Host Check ${tag}`}, 'draft')
        RETURNING id
      `,
        "draft",
      );

      const hostCheck = oneRow(
        await client<{ id: string }[]>`
        INSERT INTO recruiter_verification_submissions
          (user_id, full_name, mobile_number, status, competition_id)
        VALUES (${hostId}, 'Uji Balapan', '+628100000000', 'pending_review', ${draft.id})
        RETURNING id
      `,
        "hostCheck",
      );

      const approve = () => decideHostCheck(approverId, hostCheck.id, { decision: "approve" }, db);
      const turnDown = () =>
        decideHostCheck(
          turnDownerId,
          hostCheck.id,
          {
            decision: "turn_down",
            guidelineItem: "kontak-nyata",
            note: "Kontak penyelenggara tidak dapat dihubungi.",
          },
          db,
        );

      const approveFirst = i % 2 === 0;
      const { outcome, barrierHeld } = await raceBehindRowLock(
        (tx) =>
          tx`SELECT id FROM recruiter_verification_submissions WHERE id = ${hostCheck.id} FOR UPDATE`,
        approveFirst ? approve : turnDown,
        approveFirst ? turnDown : approve,
      );

      const finalRow = oneRow(
        await client<{ status: string; reviewer_user_id: string | null }[]>`
        SELECT status, reviewer_user_id FROM recruiter_verification_submissions WHERE id = ${hostCheck.id}
      `,
        "finalRow",
      );
      const host = oneRow(
        await client<{ recruiter_verification_tier: string }[]>`
        SELECT recruiter_verification_tier FROM users WHERE id = ${hostId}
      `,
        "host",
      );
      const auditRows = await client<{ event_type: string }[]>`
        SELECT event_type FROM platform_ops_audit_logs
        WHERE target_user_id = ${hostId}
          AND event_type IN ('host_check.approved', 'host_check.turned_down')
        ORDER BY created_at ASC
      `;
      const events = auditRows.map((row) => row.event_type);

      const winner = approveFirst
        ? {
            status: "approved",
            reviewer: approverId,
            tier: "elevated",
            event: "host_check.approved",
          }
        : {
            status: "rejected",
            reviewer: turnDownerId,
            tier: "minimal",
            event: "host_check.turned_down",
          };
      const endStateMatchesWinner =
        finalRow.status === winner.status &&
        finalRow.reviewer_user_id === winner.reviewer &&
        host.recruiter_verification_tier === winner.tier &&
        events.length === 1 &&
        events[0] === winner.event;
      const reviewerLabel =
        finalRow.reviewer_user_id === approverId
          ? "approver"
          : finalRow.reviewer_user_id === turnDownerId
            ? "turn-downer"
            : "other";

      check(
        barrierHeld &&
          outcome.ok === 1 &&
          outcome.failCodes.length === 1 &&
          outcome.failCodes[0] === "host_check_already_decided" &&
          outcome.failStatuses[0] === 409 &&
          outcome.other.length === 0 &&
          endStateMatchesWinner,
        `iter ${i} (${approveFirst ? "approve first" : "turn-down first"}): ${describeOutcome(outcome)} barrier=${barrierHeld} final=${finalRow.status} reviewer=${reviewerLabel} tier=${host.recruiter_verification_tier} audit=[${events.join(",")}]` +
          ` [want: barrier=true ok=1 loser=host_check_already_decided(409) and the status, reviewer, tier and one audit row of the ${approveFirst ? "approval" : "turn-down"}]`,
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

  // What the cleanup left, counted by the ids this run created. A delete that removed less than it
  // should then fails the run instead of leaving rows on the database unannounced.
  const assertFixturesRemoved = async (): Promise<void> => {
    if (createdUserIds.length === 0 && createdInstitutionIds.length === 0) return;

    const survivors = oneRow(
      await client<
        {
          users: number;
          institutions: number;
          memberships: number;
          competitions: number;
          host_checks: number;
          institution_submissions: number;
          audit_rows: number;
        }[]
      >`
        SELECT
          (SELECT count(*) FROM users WHERE id = ANY(${client.array(createdUserIds)}))::int AS users,
          (SELECT count(*) FROM institutions WHERE id = ANY(${client.array(createdInstitutionIds)}))::int AS institutions,
          (SELECT count(*) FROM institution_memberships WHERE user_id = ANY(${client.array(createdUserIds)}) OR institution_id = ANY(${client.array(createdInstitutionIds)}))::int AS memberships,
          (SELECT count(*) FROM competitions WHERE institution_id = ANY(${client.array(createdInstitutionIds)}))::int AS competitions,
          (SELECT count(*) FROM recruiter_verification_submissions WHERE user_id = ANY(${client.array(createdUserIds)}))::int AS host_checks,
          (SELECT count(*) FROM institution_verification_submissions WHERE institution_id = ANY(${client.array(createdInstitutionIds)}))::int AS institution_submissions,
          (SELECT count(*) FROM platform_ops_audit_logs WHERE actor_user_id = ANY(${client.array(createdUserIds)}) OR target_user_id = ANY(${client.array(createdUserIds)}))::int AS audit_rows
      `,
      "survivors",
    );
    const survivorCounts = Object.entries(survivors);
    const total = survivorCounts.reduce((sum, [, count]) => sum + count, 0);
    const listed = survivorCounts.map(([table, count]) => `${table} ${count}`).join(", ");
    check(
      total === 0,
      `every fixture row this run seeded is removed on exit${total === 0 ? "" : `: ${total} survived (${listed})`}`,
    );
  };

  // finally does not run on a signal, so an interrupted run would leave its rows behind. SIGINT and
  // SIGTERM are caught here. SIGKILL cannot be.
  const handleSignal = (signal: NodeJS.Signals, exitCode: number): void => {
    process.once(signal, () => {
      console.log(`\n${signal} received, removing fixtures before exit`);
      void cleanup()
        .catch((error) => console.error("cleanup after signal failed:", error))
        .finally(() => {
          void client.end().finally(() => process.exit(exitCode));
        });
    });
  };

  handleSignal("SIGINT", 130);
  handleSignal("SIGTERM", 143);

  try {
    await assertReadCommitted(client);
    await runInstitutionRevokeVersusApprove();
    await runApproveVersusTurnDown();
  } finally {
    try {
      await cleanup();
    } finally {
      await assertFixturesRemoved();
      await client.end();
    }
  }

  finish(failureCount(), "INST-VERIF-T2 + HOST-CHECK-T2");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
