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
// So this file COMMITS. Everything it writes is real, and everything it writes is deleted again.
// See the teardown contract below, which is the price of running here at all.
//
// BARRIERED, NOT SLEEP-TIMED. A race reproduced by starting two operations and hoping they overlap
// proves nothing on the run where they did not, and the failure is invisible: the test passes. Here
// a third connection takes the contended row first, both racers are then launched and each is
// confirmed PARKED on that row's lock by polling `pg_blocking_pids`, an observation of the
// database's own wait graph, with a deadline, not a timer. Only once both are provably queued is the
// barrier released. The queue order is what the racer launch order sets, so each ordering is run
// deliberately rather than sampled.
//
// WHAT MAKES THESE REAL TESTS RATHER THAN DESCRIPTIONS OF A DESIGN: deleting the lock does not make
// them flaky, it makes them fail. The operation never reaches the barrier, the poll runs out, and
// the failure names the missing lock. Moving the lock below the check it is supposed to protect is
// caught differently: both operations commit and the assertion on the surviving state goes red.
// Both directions are exercised deliberately; neither is inferred.
// In the team withdrawal describe, and for a candidate's own cancel of an individual registration,
// the cancel's row update parks on the row the lock would take, so a cancel whose lock call is
// deleted passes the poll there and the red is on the surviving state.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// THE SEAM AT OBJECT STORAGE, drawn there rather than at anything this file
// exists to measure. The proof writers confirm the uploaded object before recording it, and there
// is no R2 here, so without this the racers would fail on a missing bucket long before they
// reached the row they are supposed to contend over, and a lock proof would turn into a
// configuration error wearing the same red.
//
// The lock behaviour is untouched: only the two storage calls that reach the network are replaced.
vi.mock("@/server/storage/r2.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/storage/r2.client")>()),
  headObject: vi.fn(async () => ({ sizeBytes: 2048, contentType: "image/jpeg" })),
  deleteObject: vi.fn(async () => undefined),
}));
// The team registration and withdrawal, and an operator's cancellation, announce themselves on the
// queue. Replaced so a committed race writes no job to a real queue; every other enqueue in this
// file is the real one.
vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  enqueueRegistrationConfirmed: vi.fn(async () => ({})),
  enqueueRegistrationCancelled: vi.fn(async () => ({})),
  enqueueCompetitionCancelled: vi.fn(async () => ({})),
  enqueueCompetitionEdited: vi.fn(async () => ({})),
  enqueueCompetitionSearchSync: vi.fn(async () => ({})),
}));
import * as schema from "@/server/db/schema";
import { enqueueCompetitionEdited } from "@/server/async/enqueue";
import { CompetitionError } from "@/server/competitions/competition-core";

// Every row this file creates carries this marker in a slug, a username or an email.
//
// It is the recovery mechanism for the case a signal handler cannot cover. A handler runs on
// SIGINT; nothing runs on SIGKILL, on a killed container, or on a laptop closing mid-run, and a
// harness that commits real rows has to survive being killed, not just being cancelled. So the
// marker sweep at `beforeAll` removes anything a PREVIOUS run left behind before this one starts,
// and the same sweep runs again at the end. Together they mean the worst outcome of a hard kill is
// stale rows that live until the next run, not stale rows forever.
const MARKER = "racefx";

// The deadline sits in 2020 so this harness's payment is the only one the sweep can select.
//
// `sweepExpiredPayments` is global by construction. It walks every overdue manual payment in the
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
 * second racer as blocked by the first racer, not by the barrier. A direct-membership check reads
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
 * one millisecond costs one millisecond, and the deadline exists only to turn a hang into a named
 * failure.
 */
const awaitBlockedBy = async (
  waiterPid: number,
  holderPid: number,
  what: string,
): Promise<void> => {
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
      `lock, the lock is what broke. Do NOT raise BARRIER_TIMEOUT_MS to make it pass. A longer ` +
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
 * The `finally` here is not defensive tidiness. It is the only reason this suite can report a
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

/**
 * Holds the competition participation advisory lock on the barrier connection.
 *
 * `withRowHeld` cannot serve here: an advisory lock has no row to take FOR UPDATE, and the whole
 * point of Rule 25's second clause is that the contended rows do not exist yet. A registration
 * that has not been inserted cannot be locked, which is exactly why a compare-and-set has nothing
 * to serialize on and an advisory lock is the only thing that does.
 *
 * The key is rebuilt here rather than imported so the test states the string it expects the service
 * to take. A namespace change on one side and not the other has to show up as a test that stops
 * blocking, not as two constants silently agreeing to differ.
 */
const withParticipationLockHeld = async <T>(
  competitionId: string,
  body: (track: TrackRacer) => Promise<T>,
): Promise<T> => {
  const lockKey = `competition_participation:${competitionId}`;

  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => (markAcquired = resolve));
  let allowRelease!: () => void;
  const released = new Promise<void>((resolve) => (allowRelease = resolve));

  const holding = barrier.sql.begin(async (tx) => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    markAcquired();
    await released;
  });

  await Promise.race([
    acquired,
    holding.then(() => {
      throw new Error("the barrier transaction ended before it took the participation lock");
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

  // The institution's owner. Pricing is owner-only, so without this the fee racer would be refused
  // by the access gate before it ever reached the lock, and the contention test would measure the
  // refusal instead of the block.
  await control.sql`
    insert into institution_memberships (institution_id, user_id, membership_role, status)
    values (${institution!.id}, ${user!.id}, 'institution_owner', 'active')`;

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
 * A forming team of two on a published, priced competition that allows withdrawal, COMMITTED. The
 * competition takes teams only unless the caller asks for one that also takes individuals.
 */
const seedCommittedPricedTeam = async (
  mode: "team" | "both" = "team",
): Promise<{
  captainUserId: string;
  memberUserId: string;
  institutionId: string;
  competitionId: string;
  teamId: string;
}> => {
  const id = `${Date.now()}_${seedCounter++}`;
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const [captain] = await control.db
    .insert(schema.users)
    .values({
      email: `${MARKER}_${id}_captain@example.test`,
      username: `${MARKER}_${id}_captain`,
      candidateVerifiedAt: FEE_RULE_FROM,
    })
    .returning({ id: schema.users.id });

  const [member] = await control.db
    .insert(schema.users)
    .values({
      email: `${MARKER}_${id}_member@example.test`,
      username: `${MARKER}_${id}_member`,
      candidateVerifiedAt: FEE_RULE_FROM,
    })
    .returning({ id: schema.users.id });

  const [institution] = await control.db
    .insert(schema.institutions)
    .values({
      slug: `${MARKER}-inst-${id}`,
      institutionType: "company",
      displayName: `Race team ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: schema.institutions.id });

  await control.db.insert(schema.institutionPaymentInstructions).values({
    institutionId: institution!.id,
    bankName: "Bank Contoh",
    accountNumber: "1234567890",
    accountHolderName: "Panitia Lomba",
  });

  await control.db.insert(schema.financeFeeRules).values({
    institutionId: institution!.id,
    currency: "IDR",
    basisPoints: 250,
    flatAmount: 0,
    effectiveFrom: FEE_RULE_FROM,
  });

  const [competition] = await control.db
    .insert(schema.competitions)
    .values({
      institutionId: institution!.id,
      slug: `${MARKER}-comp-${id}`,
      title: `Race team ${id}`,
      status: "published",
      mode,
      minTeamSize: 2,
      maxTeamSize: 4,
      registrationStartAt: new Date(now - DAY_MS),
      registrationEndAt: new Date(now + 30 * DAY_MS),
      eventStartAt: new Date(now + 60 * DAY_MS),
      allowCancellation: true,
      cancellationCutoffDays: 1,
      feeAmount: 150_000,
      feeCurrency: "IDR",
      paymentWindowDays: 3,
    })
    .returning({ id: schema.competitions.id });

  const [team] = await control.db
    .insert(schema.teams)
    .values({
      competitionId: competition!.id,
      captainId: captain!.id,
      name: `Tim ${id}`,
      status: "forming",
    })
    .returning({ id: schema.teams.id });

  await control.db.insert(schema.teamMemberships).values([
    { teamId: team!.id, userId: captain!.id, role: "captain", status: "active" },
    { teamId: team!.id, userId: member!.id, role: "member", status: "active" },
  ]);

  return {
    captainUserId: captain!.id,
    memberUserId: member!.id,
    institutionId: institution!.id,
    competitionId: competition!.id,
    teamId: team!.id,
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
  await control.sql`
    delete from team_memberships where team_id in
      (select t.id from teams t join competitions c on c.id = t.competition_id
       where c.slug like ${slug})`;
  await control.sql`
    delete from teams where competition_id in
      (select id from competitions where slug like ${slug})`;
  await control.sql`
    delete from finance_fee_disclosure_acknowledgements where competition_id in
      (select id from competitions where slug like ${slug})`;
  await control.sql`delete from competitions where slug like ${slug}`;
  await control.sql`
    delete from finance_fee_rules where institution_id in
      (select id from institutions where slug like ${slug})`;
  await control.sql`
    delete from institution_payment_instructions where institution_id in
      (select id from institutions where slug like ${slug})`;
  await control.sql`
    delete from platform_ops_audit_logs where target_institution_id in
      (select id from institutions where slug like ${slug})`;
  await control.sql`
    delete from institution_memberships where institution_id in
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
      join competitions c on c.id = r.competition_id where c.slug like ${slug}
    union all
    select 'finance_fee_disclosure_acknowledgements', count(*)
      from finance_fee_disclosure_acknowledgements a
      join competitions c on c.id = a.competition_id where c.slug like ${slug}
    union all
    select 'teams', count(*) from teams t
      join competitions c on c.id = t.competition_id where c.slug like ${slug}
    union all
    select 'team_memberships', count(*) from team_memberships m
      join teams t on t.id = m.team_id
      join competitions c on c.id = t.competition_id where c.slug like ${slug}`;

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
  // one that fails: the run hangs with no message and the real failure, whatever left the lock
  // held, is never reported. A bounded wait turns that into a named error. The racers deliberately
  // have no such timeout; waiting on the barrier is their whole job.
  await control.sql.unsafe("set lock_timeout = '10s'");

  // A previous run that was killed rather than cancelled left rows behind. Remove them before
  // seeding, or `assertOnlyOverduePayment` fails on data this run did not create and the real
  // finding (a leak) is reported as an unrelated test failure.
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
    const { submitManualPaymentProof } =
      await import("@/server/finance/manual-payment-proof-service");
    return submitManualPaymentProof(
      {
        paymentId: fixture.paymentId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${fixture.paymentId}/bukti.jpg`,
        originalFileName: "bukti.jpg",
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

  it("without contention the same upload succeeds, so the refusal above is the race, not a blanket bar", async () => {
    // The negative control. Without it, a `submitManualPaymentProof` that refused unconditionally
    // would pass the worker-first test, and the race would be proving nothing at all.
    const fixture = await seedCommittedFixture();

    const submitted = await runSubmit(racerOne, fixture);

    expect(submitted.status).toBe("pending_review");
    expect((await registrationRow(fixture.registrationId)).status).toBe("confirmed");
  });

  it("an upload waits for the participation lock, so it cannot land while the competition is being withdrawn", async () => {
    const fixture = await seedCommittedFixture();
    const [barrierPid, racerPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
    ]);

    const [settled] = await withParticipationLockHeld(fixture.competitionId, async (track) => {
      const run = track(runSubmit(racerOne, fixture));
      await awaitBlockedBy(racerPid, barrierPid, "the proof upload");
      return [run] as const;
    });

    const outcome = await settled;
    expect(outcome.ok).toBe(true);
  });

  it("an upload holds the participation lock while it queues on the registration row", async () => {
    const fixture = await seedCommittedFixture();
    const [barrierPid, racerPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
    ]);

    const [held] = await withRowHeld(
      "competition_registrations",
      fixture.registrationId,
      async (track) => {
        track(runSubmit(racerOne, fixture));
        await awaitBlockedBy(racerPid, barrierPid, "the proof upload");
        const rows = await control.sql<{ held: number }[]>`
          select count(*)::int as held from pg_locks
          where locktype = 'advisory' and granted and pid = ${racerPid}`;
        return [rows[0]!.held] as const;
      },
    );

    expect(held).toBe(1);
  });
});

describe.skipIf(skipWithoutDatabase)(
  "reopening a closed bukti transfer, under real contention",
  () => {
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
      const { reopenManualPaymentProof } =
        await import("@/server/finance/manual-payment-proof-service");
      return reopenManualPaymentProof(
        {
          proofId,
          submittedByUserId: fixture.userId,
          r2Key: `payment-proofs/${fixture.competitionId}/${fixture.paymentId}/bukti-2.jpg`,
          originalFileName: "bukti-2.jpg",
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
      // deliberately: the bar was set against the organiser's own rejection, and a void is
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
      // A reopen of a `pending_review` proof does not merely lose the race. IT NEVER ENTERS IT. The
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

      const outcomes = await withRowHeld(
        "finance_manual_payment_proofs",
        proofId,
        async (track) => {
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
        },
      );

      expect(outcomes.filter((outcome) => outcome.ok)).toEqual([]);

      const [proof] = await proofRowsFor(fixture.paymentId);
      expect(proof!.status).toBe("pending_review");
      expect(Number(proof!.resubmission_count)).toBe(0);
    });

    it("a refile waits for the participation lock, so it cannot land while the competition is being withdrawn", async () => {
      const fixture = await seedCommittedFixture();
      const proofId = await seedProofInState(fixture, "rejected", true);
      const [barrierPid, racerPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
      ]);

      const [settled] = await withParticipationLockHeld(fixture.competitionId, async (track) => {
        const run = track(runReopen(racerOne, fixture, proofId));
        await awaitBlockedBy(racerPid, barrierPid, "the refile");
        return [run] as const;
      });

      const outcome = await settled;
      expect(outcome.ok).toBe(true);
    });

    it("a refile holds the participation lock while it queues on the registration row", async () => {
      const fixture = await seedCommittedFixture();
      const proofId = await seedProofInState(fixture, "rejected", true);
      const [barrierPid, racerPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
      ]);

      const [held] = await withRowHeld(
        "competition_registrations",
        fixture.registrationId,
        async (track) => {
          track(runReopen(racerOne, fixture, proofId));
          await awaitBlockedBy(racerPid, barrierPid, "the refile");
          const rows = await control.sql<{ held: number }[]>`
            select count(*)::int as held from pg_locks
            where locktype = 'advisory' and granted and pid = ${racerPid}`;
          return [rows[0]!.held] as const;
        },
      );

      expect(held).toBe(1);
    });
  },
);

describe.skipIf(skipWithoutDatabase)(
  "pricing a competition serializes with its participation set",
  () => {
    /**
     * THE THIRD RACE, and the one a compare-and-set structurally cannot close.
     *
     * Setting a price is refused when the competition already has active FREE registrants, because
     * one retroactively attaches a fee to people who agreed to none. That decision COUNTS ROWS, and
     * the rows it counts do not exist yet: the registration it must not miss is still in flight. There
     * is no shared row for a CAS to compare against, so the only thing that can serialize the count
     * with the registration is the advisory lock every other participation path already takes.
     *
     * Read outside the lock, the classifier sees zero free registrants, the registration commits, and
     * the price lands on a competition that took a free entrant a moment earlier.
     *
     * What this measures is the BLOCK, not the outcome: with the lock held elsewhere the fee write
     * must wait rather than proceed on a stale count. Deleting the lock from the service makes this
     * fail, because it stops waiting.
     */
    it("waits for the participation lock instead of pricing against a stale count", async () => {
      const fixture = await seedCommittedFixture();
      const { setCompetitionFee } = await import("@/server/competitions/competition-fee-service");

      const [barrierPid, racerPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
      ]);

      // Returned INSIDE an array, exactly as the reopen racers are. `withParticipationLockHeld` does
      // `await body(track)`, so handing back the bare promise would await the racer while the barrier
      // still holds the lock, and the harness would deadlock against itself and report a timeout that
      // looks like a missing lock. An array is not unwrapped by await; the finally releases first and
      // `Promise.all(inFlight)` collects the racer afterwards.
      const [settled] = await withParticipationLockHeld(fixture.competitionId, async (track) => {
        const run = track(
          setCompetitionFee(
            fixture.userId,
            fixture.competitionId,
            { feeAmount: null, feeCurrency: null },
            racerOne.db as never,
          ),
        );

        // THE ASSERTION. If the service takes the lock, this racer is parked behind the barrier; if
        // it does not, it runs straight through and this throws with the file's guard-removal notice.
        await awaitBlockedBy(racerPid, barrierPid, "the fee write");

        return [run] as const;
      });

      const outcome = await settled;
      expect(outcome.ok).toBe(true);
    });
  },
);

describe.skipIf(skipWithoutDatabase)(
  "an operator's cancellation reads the transfers under the participation lock",
  () => {
    it("a transfer committed while the cancellation waits for the lock still refuses it", async () => {
      const fixture = await seedCommittedFixture();
      const { cancelCompetitionAsOps } = await import("@/server/finance/ops-payment-service");
      const operatorName = `${MARKER}_ops_${Date.now()}_${seedCounter++}`;
      const [operator] = await control.sql<{ id: string }[]>`
        insert into users (email, username, role, candidate_verified_at)
        values (
          ${`${operatorName}@example.test`}, ${operatorName}, 'platform_ops',
          ${FEE_RULE_FROM.toISOString()}
        )
        returning id`;
      await control.sql`
        update competitions set status = 'published' where id = ${fixture.competitionId}`;
      const [barrierPid, racerPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
      ]);

      const [settled] = await withParticipationLockHeld(fixture.competitionId, async (track) => {
        const run = track(
          cancelCompetitionAsOps(
            operator!.id,
            fixture.competitionId,
            "penyelenggara tidak dapat menyelenggarakan acara",
            racerOne.db as never,
          ),
        );
        await awaitBlockedBy(racerPid, barrierPid, "the operator's cancellation");
        await control.sql`
          insert into finance_manual_payment_proofs (
            payment_id, competition_id, submitted_by_user_id, status, r2_key,
            original_file_name, file_size_bytes, content_type
          ) values (
            ${fixture.paymentId}, ${fixture.competitionId}, ${fixture.userId}, 'pending_review',
            ${`payment-proofs/${fixture.competitionId}/${fixture.paymentId}/bukti.jpg`},
            'bukti.jpg', 2048, 'image/jpeg'
          )`;
        return [run] as const;
      });

      const outcome = await settled;
      const [competition] = await control.sql<{ status: string }[]>`
        select status from competitions where id = ${fixture.competitionId}`;
      expect({
        refusal: outcome.ok ? null : errorCodeOf(outcome.error),
        competitionStatus: competition!.status,
      }).toEqual({ refusal: "ops_competition_payment_in_flight", competitionStatus: "published" });
    });
  },
);

describe.skipIf(skipWithoutDatabase)(
  "a proof upload and a team withdrawal, under real contention",
  () => {
    const registerCommittedTeam = async (): Promise<{
      captainUserId: string;
      competitionId: string;
      teamId: string;
      anchorRegistrationId: string;
      paymentId: string;
    }> => {
      const { submitTeamRegistration } = await import("@/server/teams/team-registration-service");
      const { captainUserId, competitionId, teamId } = await seedCommittedPricedTeam();

      const registered = await submitTeamRegistration(
        captainUserId,
        competitionId,
        teamId,
        control.db as never,
      );
      const captainRow = registered.registrations.find((row) => row.studentId === captainUserId);
      const payment = await control.db.query.financePayments.findFirst({
        where: (fields, { eq }) => eq(fields.competitionRegistrationId, captainRow!.id),
      });

      return {
        captainUserId,
        competitionId,
        teamId,
        anchorRegistrationId: captainRow!.id,
        paymentId: payment!.id,
      };
    };

    type TeamFixture = Awaited<ReturnType<typeof registerCommittedTeam>>;

    const registerCommittedTeamAgain = async (): Promise<TeamFixture> => {
      const { submitTeamRegistration, cancelTeamRegistration } =
        await import("@/server/teams/team-registration-service");
      const { captainUserId, competitionId, teamId } = await seedCommittedPricedTeam();

      await submitTeamRegistration(captainUserId, competitionId, teamId, control.db as never);
      await cancelTeamRegistration(
        captainUserId,
        competitionId,
        teamId,
        "berubah rencana",
        control.db as never,
      );
      const registeredAgain = await submitTeamRegistration(
        captainUserId,
        competitionId,
        teamId,
        control.db as never,
      );
      const captainRow = registeredAgain.registrations.find(
        (row) => row.studentId === captainUserId,
      );
      const payment = await control.db.query.financePayments.findFirst({
        where: (fields, { eq }) => eq(fields.competitionRegistrationId, captainRow!.id),
      });

      return {
        captainUserId,
        competitionId,
        teamId,
        anchorRegistrationId: captainRow!.id,
        paymentId: payment!.id,
      };
    };

    const runWithdrawal = async (connection: Connection, fixture: TeamFixture) => {
      const { cancelTeamRegistration } = await import("@/server/teams/team-registration-service");
      return cancelTeamRegistration(
        fixture.captainUserId,
        fixture.competitionId,
        fixture.teamId,
        "berubah rencana",
        connection.db as never,
      );
    };

    const runUpload = async (connection: Connection, fixture: TeamFixture) => {
      const { submitManualPaymentProof } =
        await import("@/server/finance/manual-payment-proof-service");
      return submitManualPaymentProof(
        {
          paymentId: fixture.paymentId,
          submittedByUserId: fixture.captainUserId,
          r2Key: `payment-proofs/${fixture.competitionId}/${fixture.paymentId}/bukti.jpg`,
          originalFileName: "bukti.jpg",
        },
        connection.db as never,
      );
    };

    const readTeamAfterRace = async (fixture: TeamFixture) => {
      const team = await control.db.query.teams.findFirst({
        where: (fields, { eq }) => eq(fields.id, fixture.teamId),
      });
      const teamRows = await control.db.query.competitionRegistrations.findMany({
        where: (fields, { eq }) => eq(fields.teamId, fixture.teamId),
      });
      const proofs = await proofRowsFor(fixture.paymentId);
      return {
        teamStatus: team?.status,
        confirmedRows: teamRows.filter((row) => row.status === "confirmed").length,
        proofStatuses: proofs.map((proof) => proof.status),
      };
    };

    it("a team withdrawal holds the participation lock while it queues on the payment's row", async () => {
      const fixture = await registerCommittedTeam();
      const [barrierPid, racerPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
      ]);

      const [held] = await withRowHeld(
        "competition_registrations",
        fixture.anchorRegistrationId,
        async (track) => {
          track(runWithdrawal(racerOne, fixture));
          await awaitBlockedBy(racerPid, barrierPid, "the team withdrawal");
          const rows = await control.sql<{ held: number }[]>`
            select count(*)::int as held from pg_locks
            where locktype = 'advisory' and granted and pid = ${racerPid}`;
          return [rows[0]!.held] as const;
        },
      );

      expect(held).toBe(1);
    });

    it("PROOF FIRST: the upload lands, and the withdrawal queued behind it is refused", async () => {
      const fixture = await registerCommittedTeam();

      const [barrierPid, uploadPid, withdrawalPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
        backendPidOf(racerTwo),
      ]);

      const [uploadResult, withdrawalResult] = await withRowHeld(
        "competition_registrations",
        fixture.anchorRegistrationId,
        async (track) => {
          const uploadRun = track(runUpload(racerOne, fixture));
          await awaitBlockedBy(uploadPid, barrierPid, "submitManualPaymentProof");

          const withdrawalRun = track(runWithdrawal(racerTwo, fixture));
          await awaitBlockedBy(withdrawalPid, barrierPid, "the team withdrawal");

          return [uploadRun, withdrawalRun] as const;
        },
      ).then(async ([uploadRun, withdrawalRun]) => [await uploadRun, await withdrawalRun] as const);

      const after = await readTeamAfterRace(fixture);
      expect({
        uploadOk: uploadResult.ok,
        withdrawalOk: withdrawalResult.ok,
        withdrawalCode: withdrawalResult.ok ? undefined : errorCodeOf(withdrawalResult.error),
        withdrawalStatus: withdrawalResult.ok
          ? undefined
          : (withdrawalResult.error as { status?: number }).status,
        ...after,
      }).toEqual({
        uploadOk: true,
        withdrawalOk: false,
        withdrawalCode: "cancellation_not_supported_for_paid",
        withdrawalStatus: 422,
        teamStatus: "submitted",
        confirmedRows: 2,
        proofStatuses: ["pending_review"],
      });
    });

    it("WITHDRAWAL FIRST: the team is withdrawn, and the upload queued behind it is refused", async () => {
      const fixture = await registerCommittedTeam();

      const [barrierPid, withdrawalPid, uploadPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
        backendPidOf(racerTwo),
      ]);

      const [withdrawalResult, uploadResult] = await withRowHeld(
        "competition_registrations",
        fixture.anchorRegistrationId,
        async (track) => {
          const withdrawalRun = track(runWithdrawal(racerOne, fixture));
          await awaitBlockedBy(withdrawalPid, barrierPid, "the team withdrawal");

          const uploadRun = track(runUpload(racerTwo, fixture));
          await awaitBlockedBy(uploadPid, barrierPid, "submitManualPaymentProof");

          return [withdrawalRun, uploadRun] as const;
        },
      ).then(async ([withdrawalRun, uploadRun]) => [await withdrawalRun, await uploadRun] as const);

      const after = await readTeamAfterRace(fixture);
      expect({
        withdrawalOk: withdrawalResult.ok,
        uploadOk: uploadResult.ok,
        uploadCode: uploadResult.ok ? undefined : errorCodeOf(uploadResult.error),
        uploadStatus: uploadResult.ok
          ? undefined
          : (uploadResult.error as { status?: number }).status,
        ...after,
      }).toEqual({
        withdrawalOk: true,
        uploadOk: false,
        uploadCode: "manual_proof_registration_cancelled",
        uploadStatus: 409,
        teamStatus: "forming",
        confirmedRows: 0,
        proofStatuses: [],
      });
    });

    it("PROOF FIRST AFTER REGISTERING AGAIN: the upload on the new payment lands, and the withdrawal queued behind it is refused", async () => {
      const fixture = await registerCommittedTeamAgain();

      const [barrierPid, uploadPid, withdrawalPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
        backendPidOf(racerTwo),
      ]);

      const [uploadResult, withdrawalResult] = await withRowHeld(
        "competition_registrations",
        fixture.anchorRegistrationId,
        async (track) => {
          const uploadRun = track(runUpload(racerOne, fixture));
          await awaitBlockedBy(uploadPid, barrierPid, "submitManualPaymentProof");

          const withdrawalRun = track(runWithdrawal(racerTwo, fixture));
          await awaitBlockedBy(withdrawalPid, barrierPid, "the team withdrawal");

          return [uploadRun, withdrawalRun] as const;
        },
      ).then(async ([uploadRun, withdrawalRun]) => [await uploadRun, await withdrawalRun] as const);

      const after = await readTeamAfterRace(fixture);
      expect({
        uploadOk: uploadResult.ok,
        withdrawalOk: withdrawalResult.ok,
        withdrawalCode: withdrawalResult.ok ? undefined : errorCodeOf(withdrawalResult.error),
        withdrawalStatus: withdrawalResult.ok
          ? undefined
          : (withdrawalResult.error as { status?: number }).status,
        ...after,
      }).toEqual({
        uploadOk: true,
        withdrawalOk: false,
        withdrawalCode: "cancellation_not_supported_for_paid",
        withdrawalStatus: 422,
        teamStatus: "submitted",
        confirmedRows: 2,
        proofStatuses: ["pending_review"],
      });
    });
  },
);

describe.skipIf(skipWithoutDatabase)(
  "a proof upload and a candidate's own cancel, under real contention",
  () => {
    type CancelFixture = {
      cancellerUserId: string;
      payerUserId: string;
      competitionId: string;
      registrationId: string;
      anchorRegistrationId: string;
      paymentId: string;
    };

    const registerCommittedIndividual = async (): Promise<CancelFixture> => {
      const { createIndividualRegistration } =
        await import("@/server/registrations/registration-service");
      const { memberUserId, competitionId } = await seedCommittedPricedTeam("both");

      const registration = await createIndividualRegistration(
        memberUserId,
        competitionId,
        control.db as never,
      );
      const payment = await control.db.query.financePayments.findFirst({
        where: (fields, { eq }) => eq(fields.competitionRegistrationId, registration.id),
      });

      return {
        cancellerUserId: memberUserId,
        payerUserId: memberUserId,
        competitionId,
        registrationId: registration.id,
        anchorRegistrationId: registration.id,
        paymentId: payment!.id,
      };
    };

    const registerCommittedTeamMember = async (): Promise<CancelFixture> => {
      const { submitTeamRegistration } = await import("@/server/teams/team-registration-service");
      const { captainUserId, memberUserId, competitionId, teamId } =
        await seedCommittedPricedTeam();

      const registered = await submitTeamRegistration(
        captainUserId,
        competitionId,
        teamId,
        control.db as never,
      );
      const captainRow = registered.registrations.find((row) => row.studentId === captainUserId);
      const memberRow = registered.registrations.find((row) => row.studentId === memberUserId);
      const payment = await control.db.query.financePayments.findFirst({
        where: (fields, { eq }) => eq(fields.competitionRegistrationId, captainRow!.id),
      });

      return {
        cancellerUserId: memberUserId,
        payerUserId: captainUserId,
        competitionId,
        registrationId: memberRow!.id,
        anchorRegistrationId: captainRow!.id,
        paymentId: payment!.id,
      };
    };

    const runCancel = async (connection: Connection, fixture: CancelFixture) => {
      const { cancelRegistration } = await import("@/server/registrations/registration-service");
      return cancelRegistration(
        fixture.cancellerUserId,
        fixture.competitionId,
        fixture.registrationId,
        "berubah rencana",
        connection.db as never,
      );
    };

    const runUpload = async (connection: Connection, fixture: CancelFixture) => {
      const { submitManualPaymentProof } =
        await import("@/server/finance/manual-payment-proof-service");
      return submitManualPaymentProof(
        {
          paymentId: fixture.paymentId,
          submittedByUserId: fixture.payerUserId,
          r2Key: `payment-proofs/${fixture.competitionId}/${fixture.paymentId}/bukti.jpg`,
          originalFileName: "bukti.jpg",
        },
        connection.db as never,
      );
    };

    const readAfterRace = async (fixture: CancelFixture) => {
      const ownRow = await registrationRow(fixture.registrationId);
      const anchorRow = await registrationRow(fixture.anchorRegistrationId);
      const proofs = await proofRowsFor(fixture.paymentId);
      return {
        registrationStatus: ownRow.status,
        anchorStatus: anchorRow.status,
        proofStatuses: proofs.map((proof) => proof.status),
      };
    };

    it("PROOF FIRST: the upload lands, and the candidate's cancel queued behind it is refused", async () => {
      const fixture = await registerCommittedIndividual();

      const [barrierPid, uploadPid, cancelPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
        backendPidOf(racerTwo),
      ]);

      const [uploadResult, cancelResult] = await withRowHeld(
        "competition_registrations",
        fixture.anchorRegistrationId,
        async (track) => {
          const uploadRun = track(runUpload(racerOne, fixture));
          await awaitBlockedBy(uploadPid, barrierPid, "submitManualPaymentProof");

          const cancelRun = track(runCancel(racerTwo, fixture));
          await awaitBlockedBy(cancelPid, barrierPid, "the candidate's cancel");

          return [uploadRun, cancelRun] as const;
        },
      ).then(async ([uploadRun, cancelRun]) => [await uploadRun, await cancelRun] as const);

      const after = await readAfterRace(fixture);
      expect({
        uploadOk: uploadResult.ok,
        cancelOk: cancelResult.ok,
        cancelCode: cancelResult.ok ? undefined : errorCodeOf(cancelResult.error),
        cancelStatus: cancelResult.ok
          ? undefined
          : (cancelResult.error as { status?: number }).status,
        ...after,
      }).toEqual({
        uploadOk: true,
        cancelOk: false,
        cancelCode: "cancellation_not_supported_for_paid",
        cancelStatus: 422,
        registrationStatus: "confirmed",
        anchorStatus: "confirmed",
        proofStatuses: ["pending_review"],
      });
    });

    it("CANCEL FIRST: the candidate's registration is cancelled, and the upload queued behind it is refused", async () => {
      const fixture = await registerCommittedIndividual();

      const [barrierPid, cancelPid, uploadPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
        backendPidOf(racerTwo),
      ]);

      const [cancelResult, uploadResult] = await withRowHeld(
        "competition_registrations",
        fixture.anchorRegistrationId,
        async (track) => {
          const cancelRun = track(runCancel(racerOne, fixture));
          await awaitBlockedBy(cancelPid, barrierPid, "the candidate's cancel");

          const uploadRun = track(runUpload(racerTwo, fixture));
          await awaitBlockedBy(uploadPid, barrierPid, "submitManualPaymentProof");

          return [cancelRun, uploadRun] as const;
        },
      ).then(async ([cancelRun, uploadRun]) => [await cancelRun, await uploadRun] as const);

      const after = await readAfterRace(fixture);
      expect({
        cancelOk: cancelResult.ok,
        uploadOk: uploadResult.ok,
        uploadCode: uploadResult.ok ? undefined : errorCodeOf(uploadResult.error),
        uploadStatus: uploadResult.ok
          ? undefined
          : (uploadResult.error as { status?: number }).status,
        ...after,
      }).toEqual({
        cancelOk: true,
        uploadOk: false,
        uploadCode: "manual_proof_registration_cancelled",
        uploadStatus: 409,
        registrationStatus: "cancelled",
        anchorStatus: "cancelled",
        proofStatuses: [],
      });
    });

    it("A TEAM ROW: a member's own cancel is refused without waiting on the captain's row, and every row stays confirmed", async () => {
      const fixture = await registerCommittedTeamMember();

      const outcome = await withRowHeld(
        "competition_registrations",
        fixture.anchorRegistrationId,
        async (track) => {
          const cancelRun = track(runCancel(racerOne, fixture));
          const waitedTooLong = new Promise<"waited">((resolve) =>
            setTimeout(() => resolve("waited"), BARRIER_TIMEOUT_MS),
          );
          return Promise.race([cancelRun, waitedTooLong]);
        },
      );

      const after = await readAfterRace(fixture);
      expect({
        cancelOutcome: outcome === "waited" ? "waited on the captain's row" : "settled",
        cancelOk: outcome === "waited" ? undefined : outcome.ok,
        cancelCode: outcome === "waited" || outcome.ok ? undefined : errorCodeOf(outcome.error),
        cancelStatus:
          outcome === "waited" || outcome.ok
            ? undefined
            : (outcome.error as { status?: number }).status,
        ...after,
      }).toEqual({
        cancelOutcome: "settled",
        cancelOk: false,
        cancelCode: "registration_team_row_use_team_flow",
        cancelStatus: 409,
        registrationStatus: "confirmed",
        anchorStatus: "confirmed",
        proofStatuses: [],
      });
    });

    it("a candidate's cancel holds the participation lock while it queues on the payment's row", async () => {
      const fixture = await registerCommittedIndividual();
      const [barrierPid, racerPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
      ]);

      const [held] = await withRowHeld(
        "competition_registrations",
        fixture.anchorRegistrationId,
        async (track) => {
          track(runCancel(racerOne, fixture));
          await awaitBlockedBy(racerPid, barrierPid, "the candidate's cancel");
          const rows = await control.sql<{ held: number }[]>`
            select count(*)::int as held from pg_locks
            where locktype = 'advisory' and granted and pid = ${racerPid}`;
          return [rows[0]!.held] as const;
        },
      );

      expect(held).toBe(1);
    });

    it("without a payment, a candidate's own cancel goes through as before", async () => {
      const { createIndividualRegistration, cancelRegistration } =
        await import("@/server/registrations/registration-service");
      const { memberUserId, competitionId } = await seedCommittedPricedTeam("both");
      await control.sql`
      update competitions set fee_amount = null, fee_currency = null where id = ${competitionId}`;

      const registration = await createIndividualRegistration(
        memberUserId,
        competitionId,
        control.db as never,
      );
      const cancelled = await settle(
        cancelRegistration(
          memberUserId,
          competitionId,
          registration.id,
          "berubah rencana",
          control.db as never,
        ),
      );

      const payments = await control.sql<{ count: string }[]>`
        select count(*) as count from finance_payments
        where competition_registration_id = ${registration.id}`;
      expect({
        cancelOk: cancelled.ok,
        registrationStatus: (await registrationRow(registration.id)).status,
        payments: Number(payments[0]!.count),
      }).toEqual({ cancelOk: true, registrationStatus: "cancelled", payments: 0 });
    });
  },
);

describe.skipIf(skipWithoutDatabase)(
  "a close extension and a fee edit decide under the participation lock",
  () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /**
     * A priced competition that passes the publish checklist, COMMITTED, with an owner who may
     * publish it. Draft or published as asked, so the same fixture serves the extension of a live
     * close and the fee edit that a publish overtakes.
     */
    const seedCommittedPublishablePricedCompetition = async (status: "draft" | "published") => {
      const id = `${Date.now()}_${seedCounter++}`;
      const now = Date.now();
      const registrationEndAt = new Date(now + 14 * DAY_MS);

      const [owner] = await control.db
        .insert(schema.users)
        .values({
          email: `${MARKER}_${id}_owner@example.test`,
          username: `${MARKER}_${id}_owner`,
          role: "recruiter",
          candidateVerifiedAt: FEE_RULE_FROM,
          recruiterVerifiedAt: FEE_RULE_FROM,
          recruiterVerificationTier: "elevated",
        })
        .returning({ id: schema.users.id });

      const [institution] = await control.db
        .insert(schema.institutions)
        .values({
          slug: `${MARKER}-inst-${id}`,
          institutionType: "company",
          displayName: `Race close ${id}`,
          verificationStatus: "verified",
        })
        .returning({ id: schema.institutions.id });

      await control.db.insert(schema.institutionMemberships).values({
        institutionId: institution!.id,
        userId: owner!.id,
        membershipRole: "institution_owner",
        status: "active",
      });

      await control.db.insert(schema.institutionPaymentInstructions).values({
        institutionId: institution!.id,
        bankName: "Bank Contoh",
        accountNumber: "1234567890",
        accountHolderName: "Panitia Lomba",
      });

      await control.db.insert(schema.financeFeeRules).values({
        institutionId: institution!.id,
        currency: "IDR",
        basisPoints: 250,
        flatAmount: 0,
        effectiveFrom: FEE_RULE_FROM,
      });

      const [competition] = await control.db
        .insert(schema.competitions)
        .values({
          institutionId: institution!.id,
          slug: `${MARKER}-comp-${id}`,
          title: `Race close ${id}`,
          description: "Deskripsi kompetisi untuk pengujian.",
          category: "hackathon",
          mode: "individual",
          location: "online",
          audience: ["umum"],
          organizerContactKind: "whatsapp",
          organizerContactValue: "6281234567890",
          status,
          registrationStartAt: new Date(now - DAY_MS),
          registrationEndAt,
          participantConfirmationAt: new Date(now + 20 * DAY_MS),
          eventStartAt: new Date(now + 30 * DAY_MS),
          eventEndAt: new Date(now + 31 * DAY_MS),
          resultAnnouncementAt: new Date(now + 40 * DAY_MS),
          allowCancellation: true,
          cancellationCutoffDays: 1,
          feeAmount: 150_000,
          feeCurrency: "IDR",
          paymentWindowDays: 3,
        })
        .returning({ id: schema.competitions.id });

      return { ownerUserId: owner!.id, competitionId: competition!.id, registrationEndAt };
    };

    const registerCommittedCandidate = async (competitionId: string) => {
      const { createIndividualRegistration } =
        await import("@/server/registrations/registration-service");
      const id = `${Date.now()}_${seedCounter++}`;
      const [candidate] = await control.db
        .insert(schema.users)
        .values({
          email: `${MARKER}_${id}_candidate@example.test`,
          username: `${MARKER}_${id}_candidate`,
          candidateVerifiedAt: FEE_RULE_FROM,
        })
        .returning({ id: schema.users.id });

      const registration = await createIndividualRegistration(
        candidate!.id,
        competitionId,
        control.db as never,
      );
      const payment = await control.db.query.financePayments.findFirst({
        where: (fields, { eq }) => eq(fields.competitionRegistrationId, registration.id),
      });

      return { candidateUserId: candidate!.id, paymentId: payment!.id };
    };

    const commitPendingProof = async (
      competitionId: string,
      candidateUserId: string,
      paymentId: string,
    ) => {
      await control.sql`
        insert into finance_manual_payment_proofs (
          payment_id, competition_id, submitted_by_user_id, status, r2_key,
          original_file_name, file_size_bytes, content_type
        ) values (
          ${paymentId}, ${competitionId}, ${candidateUserId}, 'pending_review',
          ${`payment-proofs/${competitionId}/${paymentId}/bukti.jpg`},
          'bukti.jpg', 2048, 'image/jpeg'
        )`;
    };

    const storedCloseOf = async (competitionId: string): Promise<number> => {
      const rows = await control.sql<{ close_ms: string }[]>`
        select floor(extract(epoch from registration_end_at) * 1000)::bigint as close_ms
        from competitions where id = ${competitionId}`;
      return Number(rows[0]!.close_ms);
    };

    const runCloseExtension = async (
      connection: Connection,
      ownerUserId: string,
      competitionId: string,
      newClose: Date,
    ) => {
      const { updateCompetitionDraft } = await import("@/server/competitions/competition-service");
      return updateCompetitionDraft(
        ownerUserId,
        competitionId,
        { registrationEndAt: newClose },
        connection.db as never,
      );
    };

    // Says why the extension never queued, so an extension that failed for another reason is not
    // read as the lock being gone.
    const describeUnqueuedCloseExtension = async (run: Promise<Settled<unknown>>) => {
      const stillRunning = new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), BARRIER_TIMEOUT_MS),
      );
      const outcome = await Promise.race([run, stillRunning]);
      if (outcome === "pending") return "the close extension never queued; it did not settle";
      if (outcome.ok) return "the close extension never queued; it settled ok";
      if (outcome.error instanceof CompetitionError) {
        return `the close extension never queued; it settled with ${outcome.error.code}`;
      }
      const failure =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return `the close extension never queued; it failed with ${failure}`;
    };

    it("a proof committed while the extension waits for the lock refuses it, and the close stays", async () => {
      const fixture = await seedCommittedPublishablePricedCompetition("published");
      const { candidateUserId, paymentId } = await registerCommittedCandidate(
        fixture.competitionId,
      );
      const originalClose = await storedCloseOf(fixture.competitionId);
      const extendedClose = new Date(originalClose + DAY_MS);
      const [barrierPid, racerPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
      ]);

      const [settled] = await withParticipationLockHeld(fixture.competitionId, async (track) => {
        const run = track(
          runCloseExtension(racerOne, fixture.ownerUserId, fixture.competitionId, extendedClose),
        );
        try {
          await awaitBlockedBy(racerPid, barrierPid, "the close extension");
        } catch {
          throw new Error(await describeUnqueuedCloseExtension(run));
        }
        await commitPendingProof(fixture.competitionId, candidateUserId, paymentId);
        return [run] as const;
      });

      const outcome = await settled;
      expect({
        refusal: outcome.ok ? null : errorCodeOf(outcome.error),
        storedClose: await storedCloseOf(fixture.competitionId),
      }).toEqual({
        refusal: "competition_close_waits_for_transfer_review",
        storedClose: originalClose,
      });
    });

    it("without a proof the same extension waits for the lock and then moves the close", async () => {
      const fixture = await seedCommittedPublishablePricedCompetition("published");
      await registerCommittedCandidate(fixture.competitionId);
      const originalClose = await storedCloseOf(fixture.competitionId);
      const extendedClose = new Date(originalClose + DAY_MS);
      const [barrierPid, racerPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
      ]);

      const [settled] = await withParticipationLockHeld(fixture.competitionId, async (track) => {
        const run = track(
          runCloseExtension(racerOne, fixture.ownerUserId, fixture.competitionId, extendedClose),
        );
        await awaitBlockedBy(racerPid, barrierPid, "the close extension");
        return [run] as const;
      });

      const outcome = await settled;
      expect({
        extensionOk: outcome.ok,
        storedClose: await storedCloseOf(fixture.competitionId),
      }).toEqual({ extensionOk: true, storedClose: extendedClose.getTime() });
    });

    it("a fee edit that waits for the lock announces from the status it wrote under", async () => {
      const fixture = await seedCommittedPublishablePricedCompetition("draft");
      const { setCompetitionFee } = await import("@/server/competitions/competition-fee-service");
      const { transitionCompetitionStatus } =
        await import("@/server/competitions/competition-service");
      vi.mocked(enqueueCompetitionEdited).mockClear();
      const [barrierPid, racerPid] = await Promise.all([
        backendPidOf(barrier),
        backendPidOf(racerOne),
      ]);

      const [settled] = await withParticipationLockHeld(fixture.competitionId, async (track) => {
        const run = track(
          setCompetitionFee(
            fixture.ownerUserId,
            fixture.competitionId,
            {
              feeAmount: 150_000,
              feeCurrency: "IDR",
              paymentWindowDays: 5,
              feeDisclosureAcknowledged: true,
            },
            racerOne.db as never,
          ),
        );
        await awaitBlockedBy(racerPid, barrierPid, "the fee edit");
        // A publish takes no participation lock, so it lands while the fee edit is parked on it.
        await transitionCompetitionStatus(
          fixture.ownerUserId,
          fixture.competitionId,
          "published",
          control.db as never,
        );
        return [run] as const;
      });

      const outcome = await settled;
      if (!outcome.ok) throw outcome.error;
      expect(vi.mocked(enqueueCompetitionEdited).mock.calls.map(([job]) => job)).toEqual([
        expect.objectContaining({
          competitionId: fixture.competitionId,
          changedFields: ["paymentWindowDays"],
        }),
      ]);
    });
  },
);
