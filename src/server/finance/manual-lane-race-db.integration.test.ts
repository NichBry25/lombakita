// @vitest-environment node
//
// THE TWO RACES THE REST OF THE MANUAL LANE'S SUITE STRUCTURALLY CANNOT RUN.
//
// `manual-lane-db.integration.test.ts` opens ONE connection and wraps every test in a transaction
// it always rolls back. That is the right shape for constraint proofs and it is the wrong shape for
// a lock proof, for two reasons that are both fatal: a second connection cannot see uncommitted
// rows, so there is nothing for it to contend over; and one connection cannot block on itself, so
// `FOR UPDATE` never waits and a deleted lock looks identical to a working one.
//
// So this file COMMITS. Everything it writes is real, and everything it writes is deleted again —
// see the teardown contract below, which is the price of running here at all.
//
// BARRIERED, NOT SLEEP-TIMED. A race reproduced by starting two operations and hoping they overlap
// proves nothing on the run where they did not, and the failure is invisible: the test passes. Here
// a third connection takes the contended row first, both racers are then launched and each is
// confirmed PARKED on that row's lock by polling `pg_blocking_pids` — an observation of the
// database's own wait graph, with a deadline, not a timer. Only once both are provably queued is the
// barrier released. The queue order is what the racer launch order sets, so each ordering is run
// deliberately rather than sampled.
//
// WHAT MAKES THESE REAL TESTS RATHER THAN DESCRIPTIONS OF A DESIGN: deleting the lock does not make
// them flaky, it makes them fail. The operation never reaches the barrier, the poll runs out, and
// the failure names the missing lock. Moving the lock below the check it is supposed to protect is
// caught differently — both operations commit and the assertion on the surviving state goes red.
// Both directions are exercised deliberately; neither is inferred.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";

// Every row this file creates carries this marker in a slug, a username or an email.
//
// It is the recovery mechanism for the case a signal handler cannot cover. A handler runs on
// SIGINT; nothing runs on SIGKILL, on a killed container, or on a laptop closing mid-run — and a
// harness that commits real rows has to survive being killed, not just being cancelled. So the
// marker sweep at `beforeAll` removes anything a PREVIOUS run left behind before this one starts,
// and the same sweep runs again at the end. Together they mean the worst outcome of a hard kill is
// stale rows that live until the next run, not stale rows forever.
const MARKER = "racefx";

// The deadline sits in 2020 so this harness's payment is the only one the sweep can select.
//
// `sweepExpiredPayments` is global by construction — it walks every overdue manual payment in the
// database, which against a committed dev database means it could reach rows this file did not
// create. Dating the fixture into the past and sweeping from just after it makes the blast radius a
// property of the clock rather than a hope, and `assertOnlyOverduePayment` below verifies it every
// time rather than trusting the reasoning.
const FEE_RULE_FROM = new Date("2019-01-01T00:00:00.000Z");
const DEADLINE = new Date("2020-01-01T00:00:00.000Z");
const SWEEP_AT = new Date("2020-01-02T00:00:00.000Z");

const BARRIER_TIMEOUT_MS = 5_000;
const BARRIER_POLL_MS = 5;

type Connection = {
  label: string;
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

const openConnection = (label: string): Connection => {
  const sql = postgres(TEST_DATABASE_URL!, {
    // One connection per racer, and never recycled: the whole harness depends on a racer's queries
    // landing on the backend whose pid was captured, because that pid is what the wait graph is
    // read against. A pool would silently move a query to a different backend and the barrier would
    // wait for a block that had already happened somewhere else.
    max: 1,
    idle_timeout: 0,
  });

  return { label, sql, db: drizzle(sql, { schema }) };
};

let control: Connection;
let barrier: Connection;
let racerOne: Connection;
let racerTwo: Connection;

const backendPidOf = async (connection: Connection): Promise<number> => {
  const rows = await connection.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  return Number(rows[0]!.pid);
};

/**
 * Everything `waiterPid` is waiting on, transitively.
 *
 * TRANSITIVE, and that is not gold-plating. Postgres does not point every waiter for one row at the
 * row's holder: the first waiter takes the tuple lock and waits on the holder's transaction, and the
 * SECOND waiter then queues on the tuple lock held by the FIRST. So `pg_blocking_pids` reports the
 * second racer as blocked by the first racer, not by the barrier — a direct-membership check reads
 * a correctly formed queue as no queue at all, which is how a lock proof ends up passing for the
 * wrong reason or, as here, failing for one.
 */
const transitiveBlockersOf = async (waiterPid: number): Promise<number[]> => {
  const rows = await control.sql<{ pid: number }[]>`
    with recursive chain(pid) as (
      select unnest(pg_blocking_pids(${waiterPid}))
      union
      select unnest(pg_blocking_pids(chain.pid)) from chain
    )
    select pid from chain`;

  return rows.map((row) => Number(row.pid));
};

/**
 * Waits until `waiter` is queued behind `holder`, reading Postgres's own wait graph.
 *
 * THIS IS THE BARRIER, and its failure message is written for the person who deleted a lock. It
 * polls a CONDITION with a deadline rather than sleeping a fixed interval, so a block observed in
 * one millisecond costs one millisecond — the deadline exists only to turn a hang into a named
 * failure.
 */
const awaitBlockedBy = async (waiterPid: number, holderPid: number, what: string): Promise<void> => {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  let lastSeen: number[] = [];

  while (Date.now() < deadline) {
    lastSeen = await transitiveBlockersOf(waiterPid);

    if (lastSeen.includes(holderPid)) return;

    await new Promise((resolve) => setTimeout(resolve, BARRIER_POLL_MS));
  }

  throw new Error(
    `${what} never queued behind the row this test holds. The transitive blockers of ` +
      `${waiterPid} were last [${lastSeen.join(", ")}] and never included the holder ${holderPid}.\n` +
      `THIS IS THE GUARD-REMOVAL SIGNAL, NOT A FLAKE. The operation is expected to take that row ` +
      `FOR UPDATE and queue behind whoever holds it. If this started failing after a change to a ` +
      `lock, the lock is what broke. Do NOT raise BARRIER_TIMEOUT_MS to make it pass — a longer ` +
      `wait for a block that is never going to happen is still no block.`,
  );
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Starts a racer immediately and captures its outcome, so a rejection is data rather than noise. */
const settle = <T>(work: Promise<T>): Promise<Settled<T>> =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

/** Launches a racer and keeps it accounted for, so the harness can wait it out before tearing down. */
type TrackRacer = <T>(work: Promise<T>) => Promise<Settled<T>>;

/**
 * Holds an exclusive lock on one row for the duration of `body`, and ALWAYS gives it back.
 *
 * The `finally` here is not defensive tidiness — it is the only reason this suite can report a
 * failure at all. A barrier left holding a registration row makes the teardown's DELETE wait on it
 * forever, so an assertion failing inside the body would surface as a hung run with no message
 * rather than as a failing test. That is the exact shape of the defect this project keeps finding:
 * the mechanism that reports the problem is disabled by the problem.
 *
 * Racers launched through `track` are awaited in the same `finally`, for the second half of the same
 * reason. A racer still parked on the barrier when the body throws would wake up during teardown and
 * commit rows into the middle of the DELETE that was supposed to remove them.
 *
 * The `Promise.race` on acquisition stops a barrier that failed to take the lock from hanging the
 * suite instead of failing it.
 */
const withRowHeld = async <T>(
  table: string,
  rowId: string,
  body: (track: TrackRacer) => Promise<T>,
): Promise<T> => {
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => (markAcquired = resolve));
  let allowRelease!: () => void;
  const released = new Promise<void>((resolve) => (allowRelease = resolve));

  const holding = barrier.sql.begin(async (tx) => {
    await tx.unsafe(`select id from ${table} where id = $1 for update`, [rowId]);
    markAcquired();
    await released;
  });

  await Promise.race([
    acquired,
    holding.then(() => {
      throw new Error(`the barrier transaction on ${table} ended before it took the lock`);
    }),
  ]);

  const inFlight: Promise<unknown>[] = [];
  const track: TrackRacer = (work) => {
    const settled = settle(work);
    inFlight.push(settled);
    return settled;
  };

  try {
    return await body(track);
  } finally {
    allowRelease();
    await holding.catch(() => undefined);
    await Promise.all(inFlight);
  }
};

const errorCodeOf = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code;

type RaceFixture = {
  userId: string;
  institutionId: string;
  competitionId: string;
  registrationId: string;
  paymentId: string;
};

let seedCounter = 0;

/**
 * Seeds one payable registration and COMMITS it.
 *
 * Committed on purpose and against this file's own grain: a second connection cannot contend over a
 * row it cannot see, so the rollback isolation every other database suite here relies on would make
 * these tests silently vacuous rather than merely wrong.
 */
const seedCommittedFixture = async (): Promise<RaceFixture> => {
  const id = `${Date.now()}_${seedCounter++}`;

  const [user] = await control.sql<{ id: string }[]>`
    insert into users (email, username, candidate_verified_at)
    values (${`${MARKER}_${id}@example.test`}, ${`${MARKER}_${id}`}, ${FEE_RULE_FROM.toISOString()})
    returning id`;

  const [institution] = await control.sql<{ id: string }[]>`
    insert into institutions (slug, institution_type, verification_status)
    values (${`${MARKER}-inst-${id}`}, 'personal', 'verified')
    returning id`;

  const [competition] = await control.sql<{ id: string }[]>`
    insert into competitions (institution_id, slug, title)
    values (${institution!.id}, ${`${MARKER}-comp-${id}`}, ${`Race ${id}`})
    returning id`;

  const [registration] = await control.sql<{ id: string }[]>`
    insert into competition_registrations (competition_id, student_id, registration_type)
    values (${competition!.id}, ${user!.id}, 'individual')
    returning id`;

  const [feeRule] = await control.sql<{ id: string }[]>`
    insert into finance_fee_rules (institution_id, currency, basis_points, flat_amount, effective_from)
    values (${institution!.id}, 'IDR', 250, 0, ${FEE_RULE_FROM.toISOString()})
    returning id`;

  const [payment] = await control.sql<{ id: string }[]>`
    insert into finance_payments (
      payer_user_id, receiving_institution_id, origin, subject_type,
      competition_registration_id, currency, gross_amount, fee_rule_id,
      fee_basis_points, fee_flat_amount, platform_fee_amount, institution_net_amount, due_at
    ) values (
      ${user!.id}, ${institution!.id}, 'manual_transfer', 'competition_registration',
      ${registration!.id}, 'IDR', 1000000, ${feeRule!.id},
      250, 0, 0, 1000000, ${DEADLINE.toISOString()}
    ) returning id`;

  return {
    userId: user!.id,
    institutionId: institution!.id,
    competitionId: competition!.id,
    registrationId: registration!.id,
    paymentId: payment!.id,
  };
};

/**
 * Confirms this fixture's payment is the ONLY thing the sweep can reach at the harness clock.
 *
 * Runs before every sweep rather than once, because the guarantee is about the state of the whole
 * database at that instant and not about this file's own inserts. A developer with an old overdue
 * row would otherwise have it cancelled by a test run, which is exactly the kind of damage a
 * committing harness owes a check against rather than an argument about.
 */
const assertOnlyOverduePayment = async (paymentId: string): Promise<void> => {
  const rows = await control.sql<{ id: string }[]>`
    select id from finance_payments
    where origin = 'manual_transfer' and gross_amount > 0 and due_at < ${SWEEP_AT.toISOString()}`;

  expect(
    rows.map((row) => row.id),
    "the sweep in this test would have reached a payment this test did not create",
  ).toEqual([paymentId]);
};

const proofRowsFor = (paymentId: string) =>
  control.sql<{ id: string; status: string; resubmission_count: number }[]>`
    select id, status, resubmission_count from finance_manual_payment_proofs
    where payment_id = ${paymentId}`;

const registrationRow = async (registrationId: string) => {
  const rows = await control.sql<{ status: string; cancellation_reason: string | null }[]>`
    select status, cancellation_reason from competition_registrations where id = ${registrationId}`;
  return rows[0]!;
};

const expiredEventCount = async (paymentId: string): Promise<number> => {
  const rows = await control.sql<{ count: string }[]>`
    select count(*) as count from finance_payment_events
    where payment_id = ${paymentId} and event_type = 'expired'`;
  return Number(rows[0]!.count);
};

/**
 * Deletes every row any run of this file has ever created, matched by marker rather than by id.
 *
 * Matched by marker so it also removes what a CRASHED run left behind, which an id registry held in
 * a dead process cannot. Ordered by foreign key so each delete is legal on its own; a single
 * cascading delete would depend on cascade rules the finance tables deliberately do not have.
 */
const purgeMarkedRows = async (): Promise<void> => {
  const slug = `${MARKER}-%`;
  const username = `${MARKER}_%`;

  await control.sql`
    delete from finance_manual_payment_proof_attempts where competition_id in
      (select id from competitions where slug like ${slug})`;
  await control.sql`
    delete from finance_manual_payment_proofs where competition_id in
      (select id from competitions where slug like ${slug})`;
  await control.sql`
    delete from finance_payment_events where payment_id in
      (select p.id from finance_payments p
       join competition_registrations r on r.id = p.competition_registration_id
       join competitions c on c.id = r.competition_id
       where c.slug like ${slug})`;
  await control.sql`
    delete from finance_payment_instruction_snapshots where payment_id in
      (select p.id from finance_payments p
       join competition_registrations r on r.id = p.competition_registration_id
       join competitions c on c.id = r.competition_id
       where c.slug like ${slug})`;
  await control.sql`
    delete from finance_fee_accruals where payment_id in
      (select p.id from finance_payments p
       join competition_registrations r on r.id = p.competition_registration_id
       join competitions c on c.id = r.competition_id
       where c.slug like ${slug})`;
  await control.sql`
    delete from finance_payments where competition_registration_id in
      (select r.id from competition_registrations r
       join competitions c on c.id = r.competition_id
       where c.slug like ${slug})`;
  await control.sql`
    delete from competition_registrations where competition_id in
      (select id from competitions where slug like ${slug})`;
  await control.sql`delete from competitions where slug like ${slug}`;
  await control.sql`
    delete from finance_fee_rules where institution_id in
      (select id from institutions where slug like ${slug})`;
  await control.sql`
    delete from institution_payment_instructions where institution_id in
      (select id from institutions where slug like ${slug})`;
  await control.sql`delete from institutions where slug like ${slug}`;
  await control.sql`delete from users where username like ${username}`;
};

/** What survived the purge. Counted per table so a failure names which one leaked. */
const countMarkedSurvivors = async (): Promise<Record<string, number>> => {
  const slug = `${MARKER}-%`;
  const username = `${MARKER}_%`;

  const rows = await control.sql<{ table_name: string; count: string }[]>`
    select 'competitions' as table_name, count(*) as count from competitions where slug like ${slug}
    union all
    select 'institutions', count(*) from institutions where slug like ${slug}
    union all
    select 'users', count(*) from users where username like ${username}
    union all
    select 'competition_registrations', count(*) from competition_registrations r
      join competitions c on c.id = r.competition_id where c.slug like ${slug}
    union all
    select 'finance_payments', count(*) from finance_payments p
      join competition_registrations r on r.id = p.competition_registration_id
      join competitions c on c.id = r.competition_id where c.slug like ${slug}`;

  return Object.fromEntries(rows.map((row) => [row.table_name, Number(row.count)]));
};

const purgeOnSignal = () => {
  void purgeMarkedRows().catch(() => undefined);
};

beforeAll(async () => {
  if (skipWithoutDatabase) return;

  control = openConnection("control");
  barrier = openConnection("barrier");
  racerOne = openConnection("racer-one");
  racerTwo = openConnection("racer-two");

  // The teardown runs on this connection, and a teardown that WAITS on a stray lock is worse than
  // one that fails: the run hangs with no message and the real failure — whatever left the lock
  // held — is never reported. A bounded wait turns that into a named error. The racers deliberately
  // have no such timeout; waiting on the barrier is their whole job.
  await control.sql.unsafe("set lock_timeout = '10s'");

  // A previous run that was killed rather than cancelled left rows behind. Remove them before
  // seeding, or `assertOnlyOverduePayment` fails on data this run did not create and the real
  // finding — a leak — is reported as an unrelated test failure.
  await purgeMarkedRows();

  process.on("SIGINT", purgeOnSignal);
  process.on("SIGTERM", purgeOnSignal);
});

afterEach(async () => {
  if (skipWithoutDatabase) return;
  // In `afterEach` rather than at the end of each test body, so that an assertion failing mid-test
  // cannot skip the cleanup of rows that test already committed.
  await purgeMarkedRows();
});

afterAll(async () => {
  if (skipWithoutDatabase) return;

  process.off("SIGINT", purgeOnSignal);
  process.off("SIGTERM", purgeOnSignal);

  try {
    await purgeMarkedRows();

    const survivors = await countMarkedSurvivors();
    const leaked = Object.entries(survivors).filter(([, count]) => count > 0);

    expect(
      leaked,
      `this harness commits real rows and left some behind: ${JSON.stringify(survivors)}`,
    ).toEqual([]);
  } finally {
    // Connections close whether or not the survivor assertion passed. A leaked-row failure that
    // also leaked four connections would hang the run and hide its own message.
    await Promise.all([
      control?.sql.end(),
      barrier?.sql.end(),
      racerOne?.sql.end(),
      racerTwo?.sql.end(),
    ]);
  }
});

describe.skipIf(skipWithoutDatabase)("the deadline boundary, under real contention", () => {
  const runSweep = async (connection: Connection) => {
    const { sweepExpiredPayments } = await import("@/server/finance/payment-expiry-service");
    return sweepExpiredPayments(SWEEP_AT, connection.db as never);
  };

  const runSubmit = async (connection: Connection, fixture: RaceFixture) => {
    const { submitManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return submitManualPaymentProof(
      {
        paymentId: fixture.paymentId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${fixture.paymentId}/bukti.jpg`,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      },
      connection.db as never,
    );
  };

  it("WORKER FIRST: the sweep cancels, and the upload queued behind it is refused", async () => {
    const fixture = await seedCommittedFixture();
    await assertOnlyOverduePayment(fixture.paymentId);

    const [barrierPid, sweepPid, submitPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [sweepResult, submitResult] = await withRowHeld(
      "competition_registrations",
      fixture.registrationId,
      async (track) => {
        // Launched in the order they must acquire in. Postgres queues waiters on a tuple lock and
        // grants it in arrival order, so confirming the sweep is parked BEFORE launching the upload
        // is what makes this ordering deliberate rather than sampled.
        const sweepRun = track(runSweep(racerOne));
        await awaitBlockedBy(sweepPid, barrierPid, "the expiry sweep");

        const submitRun = track(runSubmit(racerTwo, fixture));
        await awaitBlockedBy(submitPid, barrierPid, "submitManualPaymentProof");

        return [sweepRun, submitRun] as const;
      },
    ).then(async ([sweepRun, submitRun]) => [await sweepRun, await submitRun] as const);

    expect(sweepResult.ok, "the sweep threw").toBe(true);
    if (!sweepResult.ok) throw sweepResult.error;
    expect(sweepResult.value.expired.map((outcome) => outcome.paymentId)).toEqual([
      fixture.paymentId,
    ]);

    const registration = await registrationRow(fixture.registrationId);
    expect(registration.status).toBe("cancelled");
    expect(registration.cancellation_reason).toBe("payment_deadline_expired");
    expect(await expiredEventCount(fixture.paymentId)).toBe(1);

    expect(submitResult.ok, "the upload was accepted against a cancelled registration").toBe(false);
    if (submitResult.ok) return;
    expect(errorCodeOf(submitResult.error)).toBe("manual_proof_registration_cancelled");

    // THE ASSERTION THE WHOLE RACE EXISTS FOR. A proof row surviving next to a cancelled
    // registration is the incoherent outcome: a candidate who transferred real money, uploaded
    // their evidence, and was cancelled anyway. Move the lock below the status check and this is
    // what appears.
    expect(await proofRowsFor(fixture.paymentId)).toEqual([]);
  });

  it("CANDIDATE FIRST: the upload lands, and the sweep queued behind it declines", async () => {
    const fixture = await seedCommittedFixture();
    await assertOnlyOverduePayment(fixture.paymentId);

    const [barrierPid, submitPid, sweepPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [submitResult, sweepResult] = await withRowHeld(
      "competition_registrations",
      fixture.registrationId,
      async (track) => {
        const submitRun = track(runSubmit(racerOne, fixture));
        await awaitBlockedBy(submitPid, barrierPid, "submitManualPaymentProof");

        const sweepRun = track(runSweep(racerTwo));
        await awaitBlockedBy(sweepPid, barrierPid, "the expiry sweep");

        return [submitRun, sweepRun] as const;
      },
    ).then(async ([submitRun, sweepRun]) => [await submitRun, await sweepRun] as const);

    expect(submitResult.ok, "the upload was refused although it arrived first").toBe(true);
    if (!submitResult.ok) throw submitResult.error;
    expect(submitResult.value.status).toBe("pending_review");

    expect(sweepResult.ok, "the sweep threw").toBe(true);
    if (!sweepResult.ok) throw sweepResult.error;
    // Declined, not failed. The sweep re-read the proof table under the lock and found evidence in
    // flight, which suspends expiry however long the organiser takes to look at it.
    expect(sweepResult.value.expired).toEqual([]);
    expect(sweepResult.value.skipped).toBe(1);

    expect(await expiredEventCount(fixture.paymentId)).toBe(0);
    expect((await registrationRow(fixture.registrationId)).status).toBe("confirmed");
    expect(await proofRowsFor(fixture.paymentId)).toHaveLength(1);
  });

  it("without contention the same upload succeeds — the refusal above is the race, not a blanket bar", async () => {
    // The negative control. Without it, a `submitManualPaymentProof` that refused unconditionally
    // would pass the worker-first test, and the race would be proving nothing at all.
    const fixture = await seedCommittedFixture();

    const submitted = await runSubmit(racerOne, fixture);

    expect(submitted.status).toBe("pending_review");
    expect((await registrationRow(fixture.registrationId)).status).toBe("confirmed");
  });
});

describe.skipIf(skipWithoutDatabase)("reopening a closed bukti transfer, under real contention", () => {
  /**
   * A proof row in one of the three states a reopen can be attempted against.
   *
   * The review columns are filled for a closed status because the table insists on it: a `rejected`
   * row without a reason and a closed row without a `reviewed_at` are both refused by CHECK. That
   * refusal is the schema doing its job, so the fixture matches what a real verdict writes rather
   * than the columns being worked around.
   */
  const seedProofInState = async (
    fixture: RaceFixture,
    status: "rejected" | "voided" | "pending_review",
    resubmissionAllowed: boolean,
  ): Promise<string> => {
    const closed = status !== "pending_review";

    const rows = await control.sql<{ id: string }[]>`
      insert into finance_manual_payment_proofs (
        payment_id, competition_id, submitted_by_user_id, status, r2_key,
        original_file_name, file_size_bytes, content_type, resubmission_allowed,
        reviewer_user_id, reviewed_at, rejection_reason
      ) values (
        ${fixture.paymentId}, ${fixture.competitionId}, ${fixture.userId}, ${status},
        ${`payment-proofs/${fixture.competitionId}/${fixture.paymentId}/bukti.jpg`},
        'bukti.jpg', 2048, 'image/jpeg', ${resubmissionAllowed},
        ${closed ? fixture.userId : null},
        ${closed ? DEADLINE.toISOString() : null},
        ${status === "rejected" ? "Nominal tidak cocok" : null}
      ) returning id`;
    return rows[0]!.id;
  };

  const runReopen = async (connection: Connection, fixture: RaceFixture, proofId: string) => {
    const { reopenManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return reopenManualPaymentProof(
      {
        proofId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${fixture.paymentId}/bukti-2.jpg`,
        originalFileName: "bukti-2.jpg",
        fileSizeBytes: 4096,
        contentType: "image/jpeg",
      },
      connection.db as never,
    );
  };

  /** Both reopens released together, and what came back. */
  const contendTwoReopens = async (fixture: RaceFixture, proofId: string) => {
    const [barrierPid, firstPid, secondPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [first, second] = await withRowHeld(
      "finance_manual_payment_proofs",
      proofId,
      async (track) => {
        const firstRun = track(runReopen(racerOne, fixture, proofId));
        await awaitBlockedBy(firstPid, barrierPid, "the first reopen");

        const secondRun = track(runReopen(racerTwo, fixture, proofId));
        await awaitBlockedBy(secondPid, barrierPid, "the second reopen");

        return [firstRun, secondRun] as const;
      },
    );

    return Promise.all([first, second]);
  };

  it("REJECTED arm: two refiles contend, exactly one wins and the counter moves once", async () => {
    const fixture = await seedCommittedFixture();
    const proofId = await seedProofInState(fixture, "rejected", true);

    const outcomes = await contendTwoReopens(fixture, proofId);

    // Both CAS statements were released at the same instant against the same row. The loser
    // re-evaluated its WHERE against the winner's committed row, found `pending_review`, and matched
    // neither arm. Delete the status disjunction from that WHERE and both succeed.
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const loser = outcomes.find((outcome) => !outcome.ok);
    expect(errorCodeOf(loser && !loser.ok ? loser.error : undefined)).toBe(
      "manual_proof_resubmission_barred",
    );

    const [proof] = await proofRowsFor(fixture.paymentId);
    expect(proof!.status).toBe("pending_review");
    // ONE increment, not two. The counter is the attempt segment of the verification idempotency
    // key, so a double increment would mint attempt two's key for an attempt that never opened and
    // silently swallow the next real verification as a replay.
    expect(Number(proof!.resubmission_count)).toBe(1);
  });

  it("VOIDED arm: two refiles of a proof barred from resubmission contend, exactly one wins", async () => {
    // `resubmission_allowed = false` is the point. The voided arm ignores the organiser's bar
    // deliberately — the bar was set against the organiser's own rejection, and a void is
    // platform_ops correcting something else entirely. That arm is the newer of the two and bypasses
    // a gate, so it gets its own contention proof rather than inheriting the rejected arm's.
    const fixture = await seedCommittedFixture();
    const proofId = await seedProofInState(fixture, "voided", false);

    const outcomes = await contendTwoReopens(fixture, proofId);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const loser = outcomes.find((outcome) => !outcome.ok);
    expect(errorCodeOf(loser && !loser.ok ? loser.error : undefined)).toBe(
      "manual_proof_resubmission_barred",
    );

    const [proof] = await proofRowsFor(fixture.paymentId);
    expect(proof!.status).toBe("pending_review");
    expect(Number(proof!.resubmission_count)).toBe(1);
  });

  it("a proof still awaiting review is reopened by neither of two contending refiles", async () => {
    // The negative control for both arms at once, and it makes a sharper claim than the two tests
    // above rather than a weaker one.
    //
    // A reopen of a `pending_review` proof does not merely lose the race — IT NEVER ENTERS IT. The
    // CAS's WHERE excludes the row at scan time, so Postgres has nothing to lock and the statement
    // returns while this test is still holding an exclusive lock on that very row. Both refusals
    // therefore arrive BEFORE the barrier is released, which is why this one cannot use
    // `contendTwoReopens`: waiting for a block that correctly never happens would hang.
    //
    // Delete the status predicate from that WHERE and this is what changes: both statements would
    // suddenly match, both would block on the barrier, and this test would fail on the deadline
    // below naming exactly that.
    const fixture = await seedCommittedFixture();
    const proofId = await seedProofInState(fixture, "pending_review", true);

    const outcomes = await withRowHeld("finance_manual_payment_proofs", proofId, async (track) => {
      const both = Promise.all([
        track(runReopen(racerOne, fixture, proofId)),
        track(runReopen(racerTwo, fixture, proofId)),
      ]);

      return Promise.race([
        both,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "a reopen of a pending_review proof BLOCKED on the row this test holds. It " +
                    "should not have reached the row at all: the CAS's status predicate is what " +
                    "excludes it before any lock is taken. A reopen that waits here is a reopen " +
                    "whose WHERE would have matched.",
                ),
              ),
            BARRIER_TIMEOUT_MS,
          ),
        ),
      ]);
    });

    expect(outcomes.filter((outcome) => outcome.ok)).toEqual([]);

    const [proof] = await proofRowsFor(fixture.paymentId);
    expect(proof!.status).toBe("pending_review");
    expect(Number(proof!.resubmission_count)).toBe(0);
  });
});
