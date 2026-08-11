/**
 * Live proof that the finance ledger's idempotency guard holds under genuine concurrency.
 *
 * WHY THIS CANNOT BE A UNIT TEST. The guard is a unique INDEX consumed via `ON CONFLICT DO NOTHING`
 * — it lives entirely in Postgres. The unit suite mocks the database, so `db.insert` is a no-op and
 * DROPPING THE INDEX leaves every mocked test green. The `finance-schema-db.integration.test.ts`
 * suite does run against a real database, but it runs its appends SEQUENTIALLY inside one rolled-back
 * transaction, which is precisely the interleaving a webhook retry storm does not have: two
 * deliveries of one gateway event arrive on separate connections, at the same moment, and neither
 * can see the other's uncommitted row.
 *
 * RACE 1 — concurrent replay of one gateway event. N simultaneous appends carrying the SAME minted
 * gateway key must record EXACTLY ONE row; every racer must be told about that one row, and exactly
 * one of them must be told it was the writer. This is the shape a Xendit webhook retry takes, and
 * it is the reason the guard is `ON CONFLICT` against an index rather than a read-then-insert: a
 * read-first check has a window between the read and the insert that is exactly this race.
 *
 * RACE 2 — two genuine refunds on one payment. Two simultaneous refunds keyed by
 * `mintPlatformPaymentEventKey` must record TWO rows. Under the old `<verb>__<paymentId>` shape
 * both racers would mint the same key and the second refund would vanish — in an append-only
 * ledger, an event that never landed cannot be restated later.
 *
 * RACE 3 — cross-payment key reuse under concurrency. Two racers appending to DIFFERENT payments
 * under one key: exactly one records, and the loser is refused
 * `payment_event_idempotency_key_conflict` rather than being handed the other payment's row. This
 * is 7.1's mis-scoped-readback defect, re-proven at the interleaving that makes it reachable.
 *
 * Usage: node --import tsx scripts/concurrency/finance-idempotency-races.ts
 *   PROVE_GUARD_REMOVAL=1  drops the unique index, re-runs race 1 (whose invariant must then
 *                          collapse), and ALWAYS restores the index — deleting the rows the probe
 *                          created first, since a UNIQUE index cannot be rebuilt over duplicates.
 *                          Needs MIGRATION_DATABASE_URL: the app role owns no DDL. Development
 *                          databases only.
 * Exit code: 0 when every assertion holds; 1 otherwise.
 */

import { randomUUID } from "crypto";
import {
  assertReadCommitted,
  createChecker,
  describeOutcome,
  finish,
  oneRow,
  openPool,
  resolveIterations,
  settleAll,
  type RaceOutcome,
} from "./harness";

const ITERATIONS = resolveIterations(5);
const RACERS = 4;
const IDEMPOTENCY_INDEX = "finance_payment_events_idempotency_key_idx";

// The definition Postgres normalises migration 0056's CREATE statement into, verified by building
// that statement's text beside the live index and comparing the two `pg_indexes` rows.
//
// The exit assertion below compares against THIS, not against the index NAME, because a name-only
// check accepts an index that is non-unique, multi-column, partial, or built on a different table —
// and a subtly wrong replay guard is worse than an absent one, since every downstream reading of
// `pg_indexes` then looks correct while duplicate keys are accepted.
const IDEMPOTENCY_INDEX_DEFINITION =
  `CREATE UNIQUE INDEX ${IDEMPOTENCY_INDEX} ON public.finance_payment_events ` +
  "USING btree (idempotency_key)";
const BARRIER_WAIT_TIMEOUT_MS = 5000;
const BARRIER_POLL_INTERVAL_MS = 25;

const main = async (): Promise<void> => {
  const { client, db } = await openPool();
  await assertReadCommitted(client);

  const { appendPaymentEvent } = await import("@/server/finance/payment-service");
  const { mintGatewayPaymentEventKey, mintPlatformPaymentEventKey } =
    await import("@/server/finance/idempotency-key");

  const { check, failureCount } = createChecker();
  const createdUserIds: string[] = [];
  const createdInstitutionIds: string[] = [];

  /**
   * Confirms `finance_payment_events` still carries its replay guard, in the shape migration 0056
   * gives it.
   *
   * This runs on EVERY run, not only under `PROVE_GUARD_REMOVAL`, and it is a post-condition rather
   * than a restore. The restore inside the probe is a promise; this is the check. Any path that
   * skips a `finally` — a throw from inside one, a rewrite that moves the DROP, a future probe that
   * drops something else — leaves the table without its guard, and a script that exits 0 having
   * silently removed a uniqueness guarantee from a financial table is the worst outcome available
   * here. It has already happened once.
   *
   * What it cannot cover: a signal that kills the process outright. Nothing running in-process can.
   * That residual is why the probe refuses any host but a local one.
   */
  const assertIdempotencyGuardIntact = async (): Promise<void> => {
    const rows = await client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = ${IDEMPOTENCY_INDEX}
    `;
    const found = rows[0]?.indexdef ?? "<no such index>";
    check(
      found === IDEMPOTENCY_INDEX_DEFINITION,
      `${IDEMPOTENCY_INDEX} is present and matches migration 0056 on exit` +
        (found === IDEMPOTENCY_INDEX_DEFINITION ? "" : ` — found: ${found}`),
    );
  };

  // ---- seeding ------------------------------------------------------------

  // Raw SQL rather than the service layer: `createPayment` resolves a fee rule and is not what is
  // under test here. What matters is that the FK chain a payment needs actually exists, so the
  // insert is refused by the idempotency index and never by a foreign key.
  const seedPayment = async (): Promise<{ paymentId: string; userId: string }> => {
    const tag = randomUUID().slice(0, 8);

    const user = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO users (id, email, username, candidate_verified_at, email_verified)
        VALUES (${randomUUID()}, ${`fin_${tag}@example.test`}, ${`fin_${tag}`}, now(), now())
        RETURNING id
      `,
      "users",
    );
    createdUserIds.push(user.id);

    const institution = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO institutions (id, slug, institution_type)
        VALUES (${randomUUID()}, ${`fin-inst-${tag}`}, 'personal')
        RETURNING id
      `,
      "institutions",
    );
    createdInstitutionIds.push(institution.id);

    const competition = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO competitions (id, institution_id, slug, title)
        VALUES (${randomUUID()}, ${institution.id}, ${`fin-comp-${tag}`}, ${`Finance race ${tag}`})
        RETURNING id
      `,
      "competitions",
    );

    const registration = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO competition_registrations (id, competition_id, student_id, registration_type)
        VALUES (${randomUUID()}, ${competition.id}, ${user.id}, 'individual')
        RETURNING id
      `,
      "competition_registrations",
    );

    // Scoped to this run's own institution, NOT institution_id = NULL. A null-scoped rule is the
    // GLOBAL DEFAULT every payment in the system resolves against, so seeding one per iteration
    // would leave the fee-resolution path littered with rules this script invented — and
    // `resolveFeeRule` picks the most recently effective, so the litter is not inert.
    const feeRule = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO finance_fee_rules (id, institution_id, currency, basis_points, flat_amount, effective_from)
        VALUES (${randomUUID()}, ${institution.id}, 'IDR', 250, 0, now() - interval '30 days')
        RETURNING id
      `,
      "finance_fee_rules",
    );

    // 250 bps of 1.000.000 = 25.000 fee, 975.000 net. Pinned literally so
    // finance_payments_split_balance_chk is satisfied by arithmetic this script states outright.
    const payment = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO finance_payments (
          id, payer_user_id, receiving_institution_id, subject_type, competition_registration_id,
          currency, gross_amount, fee_rule_id, fee_basis_points, fee_flat_amount,
          platform_fee_amount, institution_net_amount
        )
        VALUES (
          ${randomUUID()}, ${user.id}, ${institution.id}, 'competition_registration', ${registration.id},
          'IDR', 1000000, ${feeRule.id}, 250, 0, 25000, 975000
        )
        RETURNING id
      `,
      "finance_payments",
    );

    return { paymentId: payment.id, userId: user.id };
  };

  const countEventsForKey = async (key: string): Promise<number> => {
    const rows = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM finance_payment_events WHERE idempotency_key = ${key}
    `;
    return rows[0]?.n ?? 0;
  };

  const countEventsForPayment = async (paymentId: string): Promise<number> => {
    const rows = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM finance_payment_events WHERE payment_id = ${paymentId}
    `;
    return rows[0]?.n ?? 0;
  };

  // ---- the barrier --------------------------------------------------------

  // Without this, race 1 proves nothing it appears to prove. `rows === 1` and `writers === 1` are
  // EXACTLY what serialized execution produces too — four deliveries that politely queued one after
  // another, each seeing the previous one's committed row, would satisfy every assertion below while
  // never contending at all. The classical control (delete the guard, watch it fail) is unavailable
  // here because dropping the index raises 42P10 rather than duplicating, so the barrier is the
  // substitute: it holds every racer at the same point and REFUSES TO REPORT unless all of them were
  // observed blocked together.
  //
  // What they block on: `appendPaymentEvent` inserts a row whose `payment_id` is a foreign key, and
  // an FK check takes `FOR KEY SHARE` on the parent `finance_payments` row. A barrier connection
  // holding `FOR UPDATE` on that row conflicts with it, so every racer parks at its FK check —
  // BEFORE its insert reaches the unique index. Releasing the barrier then puts all of them at the
  // index at once, which is the interleaving a webhook retry storm actually produces.
  // Same technique as mfa-factor-races.ts's raceBehindRowLock, against a different lock.
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

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForBlockedRacers = async (expected: number): Promise<boolean> => {
    const deadline = Date.now() + BARRIER_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await countBlockedBackends()) >= expected) return true;
      await delay(BARRIER_POLL_INTERVAL_MS);
    }
    return false;
  };

  // `paymentIds` is a LIST because a racer only parks on the row its own insert references. Race 3
  // appends to two different payments, so locking one of them would leave the other racer free to
  // run to completion — the barrier would report held while half the race never happened.
  const raceBehindPaymentLock = async (
    paymentIds: string[],
    operations: Array<() => Promise<unknown>>,
  ): Promise<{ outcome: RaceOutcome; barrierHeld: boolean }> => {
    let releaseBarrier: () => void = () => {};
    const barrierReleased = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const barrier = client.begin(async (tx) => {
      // `TransactionSql` is not callable as a tagged template under this postgres-js version's
      // types, so the cast is what lets the barrier hold its lock — same shape mfa-factor-races.ts
      // uses for the same reason.
      const lock = tx as unknown as typeof client;
      for (const paymentId of paymentIds) {
        await lock`SELECT id FROM finance_payments WHERE id = ${paymentId} FOR UPDATE`;
      }
      await barrierReleased;
    });
    // The barrier is awaited below, past two `await`s — the same unhandled-rejection kill path the
    // racers have, for the same reason.
    barrier.catch(() => {});

    // Let the barrier transaction actually acquire its lock before the racers start, or they can
    // slip past it and the whole exercise silently degrades to an unsynchronised race.
    await delay(50);

    // The racers start here but are not awaited until `settleAll` below, and `waitForBlockedRacers`
    // sits in between. A racer that rejects during that gap has no handler attached yet, which Node
    // treats as an unhandled rejection and answers by killing the process — skipping the caller's
    // `finally`. That is not theoretical: with the unique index dropped, every racer rejects
    // immediately with SQLSTATE 42P10, and the guard-removal probe exited without restoring the
    // index it had just dropped from a financial table. Attaching a handler now marks the rejection
    // handled without consuming it; `settleAll` still sees every outcome.
    const inFlight = operations.map((operation) => {
      const running = operation();
      running.catch(() => {});
      return running;
    });
    const allQueued = await waitForBlockedRacers(operations.length);

    releaseBarrier();
    await barrier;

    return { outcome: await settleAll(inFlight), barrierHeld: allQueued };
  };

  // ---- RACE 1: concurrent replay of one gateway event ---------------------

  // `recordCheck` is a parameter so the guard-removal probe can run this same race against a
  // THROWAWAY checker: that run is expected to fail every assertion, and those failures are the
  // probe's evidence, not the script's verdict. Counting them into the real checker would make a
  // successful proof exit 1.
  const runGatewayReplayRace = async (
    label = "RACE 1",
    recordCheck: (condition: boolean, checkLabel: string) => void = check,
  ): Promise<{ rowsPerRun: number[]; keys: string[] }> => {
    console.log(`\n${label}: ${RACERS} concurrent deliveries of one gateway event`);
    const rowsPerRun: number[] = [];
    const keys: string[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      const { paymentId } = await seedPayment();
      const key = mintGatewayPaymentEventKey({
        provider: "xendit",
        eventType: "succeeded",
        providerEventId: `evt_${randomUUID().slice(0, 12).replace(/-/g, "")}`,
      });
      keys.push(key);

      const deliver = () =>
        appendPaymentEvent(
          { type: "gateway" },
          {
            paymentId,
            eventType: "succeeded",
            occurredAt: new Date(),
            amount: 1_000_000,
            currency: "IDR",
            idempotencyKey: key,
          },
          db as never,
        );

      const { outcome, barrierHeld } = await raceBehindPaymentLock(
        [paymentId],
        Array.from({ length: RACERS }, () => deliver),
      );
      const rows = await countEventsForKey(key);
      rowsPerRun.push(rows);

      const results = outcome.values as Array<{ deduplicated: boolean; event: { id: string } }>;
      const writers = results.filter((r) => r?.deduplicated === false).length;
      const distinctEventIds = new Set(results.map((r) => r?.event?.id)).size;

      // FIRST, and it fails rather than skipping: if all four were never observed queued together,
      // the assertions underneath describe a race that did not happen.
      recordCheck(
        barrierHeld,
        `[${i}] all ${RACERS} racers were OBSERVED blocked on the barrier together`,
      );
      recordCheck(
        outcome.ok === RACERS,
        `[${i}] every delivery settled successfully — ${describeOutcome(outcome)}`,
      );
      recordCheck(rows === 1, `[${i}] exactly one row recorded for the key (found ${rows})`);
      recordCheck(
        writers === 1,
        `[${i}] exactly one racer reported itself the writer (found ${writers})`,
      );
      recordCheck(
        distinctEventIds === 1,
        `[${i}] every racer was handed the SAME event row (distinct ids: ${distinctEventIds})`,
      );
    }

    return { rowsPerRun, keys };
  };

  // ---- RACE 2: two genuine refunds on one payment ---------------------------

  const runConcurrentRefundRace = async (): Promise<void> => {
    console.log(`\nRACE 2: two concurrent refunds on one payment, keys minted per call`);

    for (let i = 0; i < ITERATIONS; i += 1) {
      const { paymentId, userId } = await seedPayment();

      await appendPaymentEvent(
        { type: "gateway" },
        {
          paymentId,
          eventType: "succeeded",
          occurredAt: new Date(),
          amount: 1_000_000,
          currency: "IDR",
          idempotencyKey: mintGatewayPaymentEventKey({
            provider: "xendit",
            eventType: "succeeded",
            providerEventId: `cap_${randomUUID().slice(0, 12).replace(/-/g, "")}`,
          }),
        },
        db as never,
      );

      const refund = (amount: number) => () =>
        appendPaymentEvent(
          { type: "user", userId },
          {
            paymentId,
            eventType: "refunded",
            occurredAt: new Date(),
            amount,
            currency: "IDR",
            reason: "concurrent partial refund",
            // Minted INSIDE the racer, which is the realistic shape — two operators, or one
            // double-submitting, each mint their own. A shared key hoisted out of the thunks would
            // be testing race 1 again.
            idempotencyKey: mintPlatformPaymentEventKey({ action: "refunded", paymentId }),
          },
          db as never,
        );

      const { outcome, barrierHeld } = await raceBehindPaymentLock(
        [paymentId],
        [refund(400_000), refund(600_000)],
      );
      const rows = await countEventsForPayment(paymentId);

      // FIRST, and it fails rather than skipping. Both assertions below hold under full
      // serialization, so without proof the two refunds were in flight together this iteration
      // demonstrates that two refunds can be recorded — not that two CONCURRENT refunds can.
      check(barrierHeld, `[${i}] both refunds were OBSERVED blocked on the barrier together`);
      check(
        outcome.ok === 2,
        `[${i}] both refunds settled successfully — ${describeOutcome(outcome)}`,
      );
      // 1 capture + 2 refunds. Under the old `<verb>__<paymentId>` key this is 2, and the ledger
      // understates what was refunded by 400.000 or 600.000 with nothing recording that it happened.
      check(rows === 3, `[${i}] capture plus BOTH refunds recorded (found ${rows} events)`);
    }
  };

  // ---- RACE 3: cross-payment key reuse ------------------------------------

  const runCrossPaymentKeyRace = async (): Promise<void> => {
    console.log(`\nRACE 3: one key, two different payments, concurrently`);

    for (let i = 0; i < ITERATIONS; i += 1) {
      const first = await seedPayment();
      const second = await seedPayment();
      const sharedKey = mintGatewayPaymentEventKey({
        provider: "xendit",
        eventType: "succeeded",
        providerEventId: `shared_${randomUUID().slice(0, 12).replace(/-/g, "")}`,
      });

      const append = (paymentId: string) => () =>
        appendPaymentEvent(
          { type: "gateway" },
          {
            paymentId,
            eventType: "succeeded",
            occurredAt: new Date(),
            amount: 1_000_000,
            currency: "IDR",
            idempotencyKey: sharedKey,
          },
          db as never,
        );

      // BOTH payment rows are locked: a racer parks only on the row its own insert references, so a
      // single-row barrier would hold one racer while the other ran to completion — and the loser's
      // refusal would then be a sequential second write, not a contended one.
      const { outcome, barrierHeld } = await raceBehindPaymentLock(
        [first.paymentId, second.paymentId],
        [append(first.paymentId), append(second.paymentId)],
      );
      const rows = await countEventsForKey(sharedKey);

      // FIRST, and it fails rather than skipping — the assertions below are satisfied by a
      // serialized pair, so they prove the guard only if the pair genuinely contended.
      check(barrierHeld, `[${i}] both racers were OBSERVED blocked on the barrier together`);
      check(rows === 1, `[${i}] exactly one row recorded across both payments (found ${rows})`);
      check(outcome.ok === 1, `[${i}] exactly one racer succeeded — ${describeOutcome(outcome)}`);
      // The loser must be REFUSED, not handed the winner's row. Being handed it would mean a
      // payment's own event was silently never recorded while the caller was told `deduplicated`.
      check(
        outcome.failCodes.length === 1 &&
          outcome.failCodes[0] === "payment_event_idempotency_key_conflict",
        `[${i}] the loser was refused with payment_event_idempotency_key_conflict — ${describeOutcome(outcome)}`,
      );
    }
  };

  // ---- guard-removal probe ------------------------------------------------

  /**
   * Proves the index is what does the work. Without it, race 1 records one row per racer — so a
   * gateway retry storm would multiply a captured payment across the ledger.
   *
   * Runs on a SEPARATE connection opened from `MIGRATION_DATABASE_URL`, because this project splits
   * privileges: the app connects as a role that owns nothing (`lombakita_app` locally), and DDL
   * belongs to the migration role. Dropping an index over the app's own pool fails with SQLSTATE
   * 42501, which is the correct posture and not something to work around by widening the app role.
   *
   * The index is restored in a `finally`, and the restored DEFINITION is then confirmed against
   * migration 0056 rather than the CREATE being assumed to have succeeded — this probe deliberately
   * removes a uniqueness guarantee from a financial table, so "I ran the restore statement" is not
   * good enough. The same assertion runs again at script exit, on every run.
   */
  const proveGuardRemoval = async (): Promise<void> => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;

    if (!migrationUrl) {
      check(
        false,
        "guard-removal probe requires MIGRATION_DATABASE_URL (the DDL-owning role) — the app role " +
          "cannot drop an index it does not own, and widening it would be the wrong fix",
      );
      return;
    }

    // A LOCAL DATABASE, AND NOTHING ELSE. Every other probe in scripts/concurrency/ gates on the
    // presence of two environment variables, which is sufficient when the worst case is a rolled-back
    // row. This one is not that: between the DROP and the CREATE, `finance_payment_events` has no
    // replay guard at all, and a SIGKILL in that window leaves a financial table permanently
    // duplicate-accepting with nothing reporting it. Two variables pointed at a shared or deployed
    // database is a plausible mistake — a pasted connection string, an exported shell — so the host
    // is checked rather than trusted.
    const host = new URL(migrationUrl).hostname;
    const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";

    if (!isLocalHost) {
      check(
        false,
        `guard-removal probe refuses to run against host "${host}" — it drops a uniqueness guard ` +
          "from a financial table, so it is restricted to a local development database",
      );
      return;
    }

    const { default: postgres } = await import("postgres");
    const ddl = postgres(migrationUrl, { max: 1 });

    console.log(`\nGUARD-REMOVAL PROBE: dropping ${IDEMPOTENCY_INDEX}`);

    try {
      await ddl.unsafe(`DROP INDEX ${IDEMPOTENCY_INDEX}`);

      let probeKeys: string[] = [];

      try {
        // The guard-removed run is EXPECTED to print FAIL lines — those failures are the proof.
        // Its checker output is noise here; the assertion that matters is the one below.
        const { rowsPerRun, keys } = await runGatewayReplayRace(
          "RACE 1 (guard removed)",
          createChecker().check,
        );
        probeKeys = keys;

        // NOT "did it record duplicates". Measured: with the index dropped every append raises
        // SQLSTATE 42P10 — `onConflictDoNothing({ target: idempotencyKey })` compiles to
        // `ON CONFLICT (idempotency_key)`, and Postgres refuses that clause outright when no unique
        // index matches it, so nothing is written at all. That is a STRONGER result than silent
        // duplication: the index is not merely a check the write path consults, it is structurally
        // required for the write path to execute. Either way the invariant "exactly one row per
        // key" stops holding, which is what this asserts.
        const invariantHeld = rowsPerRun.every((rows) => rows === 1);
        check(
          !invariantHeld,
          `race 1's invariant COLLAPSES with the index dropped (rows per run: ${rowsPerRun.join(", ")}) — ` +
            `if this line says FAIL then the checks above it are not load-bearing`,
        );
      } finally {
        // The duplicate rows the probe just created are exactly what a UNIQUE index refuses to be
        // built over, so they must go FIRST — otherwise the CREATE fails and the probe's own
        // `finally` leaves a financial table without its replay guard. Scoped to the keys this
        // probe minted; nothing else is touched.
        if (probeKeys.length > 0) {
          await ddl`DELETE FROM finance_payment_events WHERE idempotency_key = ANY(${probeKeys})`;
        }

        await ddl.unsafe(
          `CREATE UNIQUE INDEX ${IDEMPOTENCY_INDEX} ON finance_payment_events (idempotency_key)`,
        );
        await assertIdempotencyGuardIntact();
      }
    } finally {
      await ddl.end();
    }
  };

  try {
    await runGatewayReplayRace();
    await runConcurrentRefundRace();
    await runCrossPaymentKeyRace();

    if (process.env.PROVE_GUARD_REMOVAL === "1") {
      await proveGuardRemoval();
    }
  } finally {
    // Before anything else, and whether the run passed or threw: the table this script writes to
    // must still have its replay guard.
    await assertIdempotencyGuardIntact();

    // Ordered child-first; finance_payments has no ON DELETE action, matching the house convention
    // of FKs with no cascade plus service-layer discipline.
    for (const userId of createdUserIds) {
      await client`DELETE FROM finance_payment_events WHERE actor_user_id = ${userId}`;
    }
    for (const institutionId of createdInstitutionIds) {
      await client`
        DELETE FROM finance_payment_events
        WHERE payment_id IN (SELECT id FROM finance_payments WHERE receiving_institution_id = ${institutionId})
      `;
      await client`DELETE FROM finance_payments WHERE receiving_institution_id = ${institutionId}`;
      await client`DELETE FROM finance_fee_rules WHERE institution_id = ${institutionId}`;
      await client`
        DELETE FROM competition_registrations
        WHERE competition_id IN (SELECT id FROM competitions WHERE institution_id = ${institutionId})
      `;
      await client`DELETE FROM competitions WHERE institution_id = ${institutionId}`;
      await client`DELETE FROM institutions WHERE id = ${institutionId}`;
    }
    for (const userId of createdUserIds) {
      await client`DELETE FROM users WHERE id = ${userId}`;
    }
    await client.end();
  }

  finish(failureCount(), "FINANCE IDEMPOTENCY");
};

void main();
