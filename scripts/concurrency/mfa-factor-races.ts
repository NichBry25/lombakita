/**
 * Live proof of two races in the MFA factor lifecycle — both are
 * application-computed read-modify-write bugs, not lock/CAS races, so they need a different proof
 * shape than verification-cas-races.ts: the guard here is an ATOMIC SQL statement (an `x + 1`
 * expression, or a conditional UPDATE...WHERE...RETURNING), not a WHERE-clause version check against
 * a prior snapshot. The barrier technique still applies — both racers must be OBSERVED blocked on
 * the contended row before release, or the run proves nothing while passing.
 *
 * RACE 1 — failed_attempt_count lost update. Two concurrent wrong-code challenges against the same
 * factor must both be counted; a JS-computed `factor.failedAttemptCount + 1` (the pre-fix shape)
 * would have both racers read count=0 and both write 1, losing an increment and silently widening
 * the guessable window past MFA_LOCKOUT_THRESHOLD.
 *
 * RACE 2 — recovery-code double-redemption. Two concurrent redemptions of the SAME leaked code must
 * settle as exactly one success and one clean `mfa_invalid_recovery_code` refusal, with exactly one
 * pair of `mfa.recovery_code_used` / `mfa.reset` audit rows and exactly one `mfa_invalidated_at`
 * stamp. A SELECT-then-UPDATE shape (the pre-fix shape) would have let both racers read "unused"
 * before either committed, re-deleting an already-deleted factor as a silent no-op and re-stamping
 * `mfa_invalidated_at` with the loser's own `now` — which could regress the timestamp BACKWARD.
 *
 * Usage: node --import tsx scripts/concurrency/mfa-factor-races.ts
 * Exit code: 0 when every assertion holds; 1 on a lost increment, a double-redemption, or the
 * barrier never being observed held.
 */

import { randomUUID, createHash } from "crypto";
import {
  assertReadCommitted,
  createChecker,
  describeOutcome,
  finish,
  openPool,
  resolveIterations,
  settleAll,
  type RaceOutcome,
} from "./harness";

// Set BEFORE any dynamic `@/` import — env.server.ts snapshots process.env at module load, and the
// factor-service/mfa-encryption modules are imported transitively the moment factor-service is.
// Fixed, deterministic key — never a real secret, matching the integration test's convention.
process.env.MFA_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const ITERATIONS = resolveIterations(5);
const BARRIER_WAIT_TIMEOUT_MS = 5000;
const BARRIER_POLL_INTERVAL_MS = 25;

const main = async (): Promise<void> => {
  const { client, db } = await openPool();
  await assertReadCommitted(client);

  const { startMfaEnrolment, confirmMfaEnrolment, challengeMfaFactor, redeemMfaRecoveryCode } =
    await import("@/server/auth/mfa/factor-service");
  const { generateTotpCode } = await import("@/server/auth/mfa/totp");
  const { base32Decode } = await import("@/server/auth/mfa/base32");
  const { mfaFactors, platformOpsAuditLogs, users } = await import("@/server/db/schema");
  const { MFA_LOCKOUT_THRESHOLD } = await import("@/server/auth/mfa/mfa-core");
  const { eq } = await import("drizzle-orm");

  const { check, failureCount } = createChecker();
  const createdUserIds: string[] = [];

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // Same shape as verification-cas-races.ts's raceBehindRowLock: a third connection holds a row
  // lock, both racers are started (unstaggered — this is a symmetric race, not a CAS whose winner
  // direction needs alternating) and must both be observed queued behind it before it releases.
  const raceBehindRowLock = async (
    lockRow: (tx: typeof client) => Promise<unknown>,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ): Promise<{ outcome: RaceOutcome; barrierHeld: boolean }> => {
    let releaseBarrier: () => void = () => {};
    const barrierReleased = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const barrier = client.begin(async (tx) => {
      await lockRow(tx as unknown as typeof client);
      await barrierReleased;
    });

    await delay(50);

    const firstRacer = first();
    const secondRacer = second();
    const bothQueued = await waitForBlockedRacers(2);

    releaseBarrier?.();
    await barrier;

    return {
      outcome: await settleAll([firstRacer, secondRacer]),
      barrierHeld: bothQueued,
    };
  };

  const seedOperationalUser = async (prefix: string): Promise<string> => {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await client`
      INSERT INTO users (id, email, username, role, candidate_verified_at, email_verified)
      VALUES (${id}, ${`${prefix}_${tag}@example.test`}, ${`${prefix}_${tag}`}, 'platform_ops', now(), now())
    `;
    createdUserIds.push(id);
    return id;
  };

  // ---- RACE 1: failed_attempt_count lost update ----------------------------

  const runFailedAttemptCounterRace = async (): Promise<void> => {
    console.log(`\n[mfa-lockout] ${ITERATIONS} iterations, two concurrent wrong codes on one factor`);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const userId = await seedOperationalUser("mfarace_ctr");
      const now = new Date("2026-08-10T00:00:00.000Z");

      const enrolment = await startMfaEnrolment(userId, db as never);
      const secret = base32Decode(enrolment.secretBase32);
      const goodCode = generateTotpCode(secret, Math.floor(now.getTime() / 1000));
      await confirmMfaEnrolment(userId, goodCode, now, db as never);

      // Guaranteed distinct from the real code — the real code's digits rotated by one, wrapping 9->0.
      const wrongCode = goodCode
        .split("")
        .map((d) => String((Number(d) + 1) % 10))
        .join("");

      const { outcome, barrierHeld } = await raceBehindRowLock(
        (tx) => tx`SELECT id FROM mfa_factors WHERE user_id = ${userId} FOR UPDATE`,
        () => challengeMfaFactor(userId, wrongCode, now, db as never),
        () => challengeMfaFactor(userId, wrongCode, now, db as never),
      );

      const [row] = await db.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));

      // Both racers must fail with mfa_invalid_code (401), and — the actual guard under test — the
      // counter must land at exactly 2, never 1 (a lost increment) and never anything else.
      check(
        barrierHeld &&
          outcome.ok === 0 &&
          outcome.failCodes.length === 2 &&
          outcome.failCodes.every((code) => code === "mfa_invalid_code") &&
          outcome.other.length === 0 &&
          row?.failedAttemptCount === 2,
        `iter ${i}: ${describeOutcome(outcome)} barrier=${barrierHeld} failedAttemptCount=${row?.failedAttemptCount}` +
          ` [want: barrier=true both mfa_invalid_code(401) failedAttemptCount=2]`,
      );
    }
  };

  // ---- RACE 2: recovery-code double-redemption -----------------------------

  const runRecoveryCodeRedemptionRace = async (): Promise<void> => {
    console.log(`\n[mfa-recovery] ${ITERATIONS} iterations, two concurrent redemptions of one code`);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const userId = await seedOperationalUser("mfarace_rec");
      const now = new Date("2026-08-10T00:00:00.000Z");

      const enrolment = await startMfaEnrolment(userId, db as never);
      const secret = base32Decode(enrolment.secretBase32);
      const code = generateTotpCode(secret, Math.floor(now.getTime() / 1000));
      const confirmation = await confirmMfaEnrolment(userId, code, now, db as never);
      const recoveryCode = confirmation.recoveryCodes[0]!;

      const redeemAt = new Date(now.getTime() + 3600_000);
      const codeHash = createHash("sha256")
        .update(recoveryCode.trim().toUpperCase().replace(/[\s-]+/g, ""))
        .digest("hex");

      const { outcome, barrierHeld } = await raceBehindRowLock(
        (tx) => tx`SELECT id FROM mfa_recovery_codes WHERE code_hash = ${codeHash} FOR UPDATE`,
        () => redeemMfaRecoveryCode(userId, recoveryCode, redeemAt, db as never),
        () => redeemMfaRecoveryCode(userId, recoveryCode, redeemAt, db as never),
      );

      const [userRow] = await db.select().from(users).where(eq(users.id, userId));
      const auditRows = await db
        .select()
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.targetUserId, userId));
      const recoveryUsedCount = auditRows.filter((row) => row.eventType === "mfa.recovery_code_used").length;
      const resetCount = auditRows.filter((row) => row.eventType === "mfa.reset").length;

      // The loser refuses with `mfa_not_enrolled` (404), not `mfa_invalid_recovery_code` (401).
      // Both are correct refusals and the guarantee under test — exactly one redemption, one
      // invalidation stamp, one pair of audit rows — is unchanged; what moved is WHERE the loser
      // stops. Since `loadFactorForUser` holds the factor row `FOR UPDATE`, the loser now waits
      // there rather than racing ahead to the recovery-code table, and a locking read reports a row
      // the winner DELETED as absent. So it discovers the factor is gone before it ever looks at the
      // code, which is both the earlier and the more truthful answer — and it discloses nothing
      // about whether the submitted code was valid.
      check(
        barrierHeld &&
          outcome.ok === 1 &&
          outcome.failCodes.length === 1 &&
          outcome.failCodes[0] === "mfa_not_enrolled" &&
          outcome.failStatuses[0] === 404 &&
          outcome.other.length === 0 &&
          userRow?.mfaInvalidatedAt?.getTime() === redeemAt.getTime() &&
          recoveryUsedCount === 1 &&
          resetCount === 1,
        `iter ${i}: ${describeOutcome(outcome)} barrier=${barrierHeld}` +
          ` mfaInvalidatedAt=${userRow?.mfaInvalidatedAt?.toISOString()} recoveryUsedAudits=${recoveryUsedCount} resetAudits=${resetCount}` +
          ` [want: barrier=true ok=1 loser=mfa_not_enrolled(404) mfaInvalidatedAt=${redeemAt.toISOString()} recoveryUsedAudits=1 resetAudits=1]`,
      );
    }
  };

  // ---- RACE 3: lockout erased by a concurrent success -----------------------

  const runLockoutVersusSuccessRace = async (): Promise<void> => {
    console.log(
      `\n[mfa-lock-erase] ${ITERATIONS} iterations, a wrong code that should LOCK racing a correct one`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const userId = await seedOperationalUser("mfarace_lock");
      const enrolAt = new Date("2026-08-10T00:00:00.000Z");
      // Two TOTP steps later, so the correct code below is a different step from the one the
      // confirmation consumed and the replay guard does not reject it for the wrong reason.
      const raceAt = new Date(enrolAt.getTime() + 60_000);

      const enrolment = await startMfaEnrolment(userId, db as never);
      const secret = base32Decode(enrolment.secretBase32);
      await confirmMfaEnrolment(
        userId,
        generateTotpCode(secret, Math.floor(enrolAt.getTime() / 1000)),
        enrolAt,
        db as never,
      );

      // One short of the threshold: the wrong-code racer is the attempt that must engage the lock.
      await client`
        UPDATE mfa_factors SET failed_attempt_count = ${MFA_LOCKOUT_THRESHOLD - 1} WHERE user_id = ${userId}
      `;

      const goodCode = generateTotpCode(secret, Math.floor(raceAt.getTime() / 1000));
      const wrongCode = goodCode
        .split("")
        .map((d) => String((Number(d) + 1) % 10))
        .join("");

      const { outcome, barrierHeld } = await raceBehindRowLock(
        (tx) => tx`SELECT id FROM mfa_factors WHERE user_id = ${userId} FOR UPDATE`,
        () => challengeMfaFactor(userId, wrongCode, raceAt, db as never),
        () => challengeMfaFactor(userId, goodCode, raceAt, db as never),
      );

      const [row] = await db.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));
      const auditRows = await db
        .select()
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.targetUserId, userId));
      const lockedOutAudits = auditRows.filter((r) => r.eventType === "mfa.locked_out").length;

      // BOTH orderings are legal and neither is the defect. What is NEVER legal is an engaged
      // lockout that a concurrent success then ERASES: an `mfa.locked_out` row recorded while
      // `locked_until` reads null means the audit trail claims a lock that is not in force and the
      // account is open again on the very attempt that should have closed it.
      const lockoutIntact = lockedOutAudits === 0 || row?.lockedUntil !== null;
      // The correct code must not be accepted once the lock has engaged, and the wrong one must
      // never be accepted at all — so at most one racer may succeed, and only alongside no lockout.
      const settledLegally =
        (outcome.ok === 1 && lockedOutAudits === 0) || (outcome.ok === 0 && lockedOutAudits === 1);

      check(
        barrierHeld && lockoutIntact && settledLegally && outcome.other.length === 0,
        `iter ${i}: ${describeOutcome(outcome)} barrier=${barrierHeld}` +
          ` lockedUntil=${row?.lockedUntil?.toISOString() ?? "null"} failedAttemptCount=${row?.failedAttemptCount}` +
          ` lockedOutAudits=${lockedOutAudits}` +
          ` [want: barrier=true, and either ok=1 with no lockout recorded, or ok=0 with a lockout recorded AND still in force]`,
      );
    }
  };

  await runFailedAttemptCounterRace();
  await runRecoveryCodeRedemptionRace();
  await runLockoutVersusSuccessRace();

  // Cleanup — every row this script created, keyed off the users it seeded. mfa_factors and
  // mfa_recovery_codes CASCADE on user delete, but platform_ops_audit_logs deliberately does NOT
  // (audit-integrity convention, confirmed by this same review's schema-reviewer pass), so its rows
  // must be deleted explicitly first or the user delete below is refused by the FK.
  if (createdUserIds.length > 0) {
    await client`DELETE FROM platform_ops_audit_logs WHERE actor_user_id = ANY(${createdUserIds}) OR target_user_id = ANY(${createdUserIds})`;
    await client`DELETE FROM users WHERE id = ANY(${createdUserIds})`;
  }

  await client.end();
  finish(failureCount(), "MFA CONCURRENCY");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
