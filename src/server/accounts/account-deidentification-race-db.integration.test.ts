// @vitest-environment node
//
// THE RACE THE ROLLBACK-WRAPPED SUITE STRUCTURALLY CANNOT RUN.
//
// `account-deidentification-db.integration.test.ts` opens ONE connection and wraps every test in a
// transaction it always rolls back. That is the right shape for constraint proofs and the wrong
// shape for a concurrency proof, for two reasons that are both fatal: a second connection cannot see
// uncommitted rows, so there is nothing to contend over; and one connection cannot block on itself,
// so `FOR UPDATE` never waits and a removed lock looks identical to a working one.
//
// So this file COMMITS. Everything it writes is real, and everything it writes is deleted again.
//
// WHAT THE BARRIER PROVES, AND WHAT IT DOES NOT. A third connection takes the target's `users` row
// first, and both racers are then confirmed PARKED on that row by polling `pg_blocking_pids` — an
// observation of the database's own wait graph, with a deadline, not a sleep.
//
// PARKING ALONE DOES NOT PROVE THE LOCK, and this file was written believing it did. Remove the
// `for update` and both racers still park — the compare-and-set writes that same row a few statements
// later, so they simply queue there instead, and `pg_blocking_pids` reports the barrier for both.
// That was measured rather than reasoned about, and the assertion below is what the measurement
// bought: the parked backend's own `query` is read from `pg_stat_activity`, so a racer queued at the
// lock is distinguishable from one queued at the write the lock exists to precede.
//
// THE OUTCOME IS DETERMINISTIC WITHOUT THE LOCK, and saying so is the point. The compare-and-set
// (`where id = U and status <> 'deactivated'`) settles the winner whether or not the row was locked
// first, so the barrier is what makes the LOCK observable, not what makes the assertion true. The
// assertion at the end is therefore a proof of the CAS; the parking poll above it is the proof of
// the lock. They are two claims, and this file does not let one stand in for the other.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import * as schema from "@/server/db/schema";

/**
 * The one seam, drawn at object storage rather than at anything this file exists to measure. The
 * action deletes objects between the rehearsal and the commit and there is no R2 here, so without
 * this the racers would fail on a missing bucket long before they reached the row they contend over.
 * Only the three calls that reach the network are replaced.
 */
const r2 = vi.hoisted(() => ({
  objects: [] as string[],
  deleted: [] as string[],
  /**
   * A test that needs the run to STOP between its rehearsal and its commit sets both of these: the
   * first object delete calls `onStorage`, and the delete does not resolve until `storageGate` does.
   * The run's three stages are what the de-identify-versus-unsuspend race turns on — a run held here
   * has finished its rehearsal (so it holds neither lock) and has not opened the transaction that
   * commits — and it cannot be observed from the outside without a seam.
   */
  onStorage: null as null | (() => void),
  storageGate: null as null | Promise<void>,
}));

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => true,
  listObjects: async (prefix: string) =>
    r2.objects.filter((key) => key.startsWith(prefix)).map((key) => ({ key, lastModified: null })),
  deleteObject: async (key: string) => {
    r2.deleted.push(key);

    const notifier = r2.onStorage;
    r2.onStorage = null;
    notifier?.();

    if (r2.storageGate) await r2.storageGate;

    const at = r2.objects.indexOf(key);
    if (at !== -1) r2.objects.splice(at, 1);
  },
}));

import { deidentifyAccount, DeidentificationError } from "./account-deidentification-service";
import { changeMemberRole, removeMember } from "@/server/institution-members/member-service";
import { MemberError } from "@/server/institution-members/member-core";
import { unsuspendUser } from "@/server/moderation/moderation-service";
import { ModerationError } from "@/server/moderation/moderation-core";

/**
 * Every row this file creates carries this marker in an institution slug or a username, and the
 * sweep below finds them through it.
 *
 * THE MARKER HAS TO LIVE SOMEWHERE THE ACTION DOES NOT OVERWRITE. The target's username becomes
 * `deleted-<id>` and its email `deleted+<id>@deleted.invalid`, so neither can identify a tombstone a
 * killed run left behind; the personal institution's slug is rewritten the same way. What survives is
 * the membership row — revoked rather than deleted — joined to a NON-personal institution owned by
 * the operator, which is not a de-identification target and keeps its slug.
 *
 * That chain is the recovery mechanism for the case a signal handler cannot cover. A handler runs on
 * SIGINT; nothing runs on SIGKILL or on a laptop closing mid-run, and a harness that commits real
 * rows has to survive being killed. So the sweep runs at `beforeAll` to clear anything a PREVIOUS run
 * left behind, and again at the end.
 */
const MARKER = "deidentrace";

const CONNECT_OPTIONS = {
  // One connection per participant, and never recycled: the barrier depends on a racer's queries
  // landing on the backend whose pid was captured. A pool would move a query to a different backend
  // and the barrier would wait for a block that had already happened somewhere else.
  max: 1,
  idle_timeout: 0,
} as const;

type Connection = {
  label: string;
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

const openConnection = (label: string): Connection => {
  const client = postgres(TEST_DATABASE_URL!, CONNECT_OPTIONS);

  return { label, sql: client, db: drizzle(client, { schema }) };
};

const BARRIER_TIMEOUT_MS = 10_000;
const BARRIER_POLL_MS = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const backendPidOf = async (connection: Connection): Promise<number> => {
  const rows = await connection.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;

  return Number(rows[0]!.pid);
};

/**
 * Everything `waiterPid` is waiting on, transitively.
 *
 * TRANSITIVE, and that is not gold-plating: Postgres points the first waiter at the row's holder and
 * the second waiter at the FIRST WAITER's tuple lock, so a direct-membership check reads a correctly
 * formed queue as no queue at all.
 */
const transitiveBlockersOf = async (control: Connection, waiterPid: number): Promise<number[]> => {
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
 * The wait graph, polled until every pid is blocked — transitively — by `blockerPid`.
 *
 * Returns the chains rather than asserting them, so each caller names its own failure: the two
 * guards this file contends over are different locks, and one shared message would name the wrong
 * one.
 */
const chainsOnceParked = async (pids: readonly number[], blockerPid: number): Promise<number[][]> => {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const chains = await Promise.all(pids.map((pid) => transitiveBlockersOf(control, pid)));

    if (chains.every((chain) => chain.includes(blockerPid))) break;

    await sleep(BARRIER_POLL_MS);
  }

  return Promise.all(pids.map((pid) => transitiveBlockersOf(control, pid)));
};

/** The statement each parked backend is stopped on, read from the database rather than assumed. */
const parkedStatementsOf = async (
  pids: readonly number[],
): Promise<{ pid: number; query: string | null }[]> =>
  control.sql<{ pid: number; query: string | null }[]>`
    select pid, query from pg_stat_activity where pid = any(${pids})`;

/**
 * Remove everything this harness created, found through the marker.
 *
 * Ordered by the foreign keys rather than by hope: the audit rows name the target, the memberships
 * name both the institution and the target, and an institution cannot go before its memberships.
 */
const sweep = async (connection: Connection): Promise<void> => {
  // `tx.unsafe` rather than a tagged template: this repository types its connection as
  // `postgres.Sql`, and the transaction handle that `begin` hands the callback is not callable
  // under that type. This is the shape the existing race suite uses.
  await connection.sql.begin(async (tx) => {
    await tx.unsafe(
      `delete from platform_ops_audit_logs
       where target_user_id in (
               select user_id from institution_memberships
               where institution_id in (select id from institutions where slug like $1)
             )
          or actor_user_id in (select id from users where username like $2)`,
      [`${MARKER}-%`, `${MARKER}%`],
    );

    await tx.unsafe(
      `delete from institution_memberships
       where institution_id in (select id from institutions where slug like $1)
          or user_id in (select id from users where username like $2)`,
      [`${MARKER}-%`, `${MARKER}%`],
    );

    await tx.unsafe(`delete from institutions where slug like $1`, [`${MARKER}-%`]);

    await tx.unsafe(`delete from users where username like $1`, [`${MARKER}%`]);
  });
};

let control: Connection;
let barrier: Connection;
let racerOne: Connection;
let racerTwo: Connection;

describe.skipIf(skipWithoutDatabase)("deidentifyAccount under concurrency", () => {
  beforeAll(async () => {
    control = openConnection("control");
    barrier = openConnection("barrier");
    racerOne = openConnection("racer-one");
    racerTwo = openConnection("racer-two");

    await sweep(control);
  });

  afterAll(async () => {
    await sweep(control);

    for (const connection of [racerTwo, racerOne, barrier, control]) {
      await connection?.sql.end({ timeout: 5 });
    }
  });

  // A gate left open by a failing test would hold the next test's storage stage for its whole
  // timeout, turning one failure into two.
  afterEach(() => {
    r2.onStorage = null;
    r2.storageGate = null;
  });

  it("parks both racers on the target's row, then lets exactly one of them finish", async () => {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const operator = randomUUID();
    const target = randomUUID();
    const institution = randomUUID();
    const targetUsername = `${MARKER}_${suffix}`;

    await control.db.insert(schema.users).values([
      {
        id: operator,
        email: `${MARKER}-ops-${suffix}@example.test`,
        username: `${MARKER}_ops_${suffix}`,
        name: "Race Operator",
        role: "platform_ops",
        candidateVerifiedAt: new Date(),
      },
      {
        id: target,
        email: `${MARKER}-${suffix}@example.test`,
        username: targetUsername,
        name: "Race Target",
        candidateVerifiedAt: new Date(),
      },
    ]);

    // A NON-personal institution owned by the operator, with the target as a plain member. The
    // target owns nothing, so the last-owner refusal does not apply, and the membership row is the
    // marker carrier the sweep reads.
    await control.db.insert(schema.institutions).values({
      id: institution,
      slug: `${MARKER}-${suffix}`,
      institutionType: "company",
      displayName: "Race Institution",
      status: "active",
    });

    await control.db.insert(schema.institutionMemberships).values([
      {
        id: randomUUID(),
        institutionId: institution,
        userId: operator,
        membershipRole: "institution_owner",
        status: "active",
      },
      {
        id: randomUUID(),
        institutionId: institution,
        userId: target,
        membershipRole: "institution_member",
        status: "active",
      },
    ]);

    r2.objects = [`avatars/${target}/a.jpg`];
    r2.deleted = [];

    const barrierPid = await backendPidOf(barrier);
    const input = { confirmUsername: targetUsername, reason: "permintaan pemilik" };

    // Declared out here because the racers must be LAUNCHED inside the barrier and AWAITED after it
    // is released. Awaiting them in the callback would hold the row these two are waiting for, which
    // is the deadlock the barrier exists to create deliberately rather than accidentally.
    let race: Promise<PromiseSettledResult<unknown>[]> | undefined;

    await barrier.sql.begin(async (tx) => {
      await tx.unsafe(`select id from users where id = $1 for update`, [target]);

      const racerPids = [await backendPidOf(racerOne), await backendPidOf(racerTwo)];

      race = Promise.allSettled([
        deidentifyAccount(operator, target, input, racerOne.db),
        deidentifyAccount(operator, target, input, racerTwo.db),
      ]);

      // PARKED means each racer is blocked, transitively, by the barrier's own backend. Without the
      // `for update` in the writing transaction neither ever blocks and this poll runs out, which is
      // the failure that names the missing lock.
      const blockers = await chainsOnceParked(racerPids, barrierPid);

      for (const [index, chain] of blockers.entries()) {
        expect(
          chain,
          `racer ${index + 1} never parked on the target's row: the writing transaction is not ` +
            `taking it with \`for update\`, or is taking it after the checks it protects`,
        ).toContain(barrierPid);
      }

      // WHICH STATEMENT IS BLOCKED, not merely that one is. A racer that never takes the row lock
      // still parks on the target eventually — the compare-and-set writes that same row, so it waits
      // there instead — and a poll that only asks "is this backend waiting on the barrier" reports
      // that as a pass. Reading the parked statement from `pg_stat_activity` is what separates the
      // two: this asserts the racers stopped at the LOCKS, before the checks and writes they protect,
      // which is the property `for update` is there to provide.
      //
      // TWO LOCKS, ONE BARRIER. The barrier holds the row, and the institution's owner-membership
      // lock is taken before it, so the racer that gets there first holds that lock for as long as it
      // waits here and the other one queues behind it — legitimately parked on a lock, and not on the
      // target's row. Only one racer can therefore be at the row, which is why the row assertion is
      // "some racer" rather than "every racer".
      const parkedStatements = await parkedStatementsOf(racerPids);

      for (const row of parkedStatements) {
        expect(
          row.query ?? "",
          `a racer is parked on \`${row.query}\` rather than on a lock: the writing transaction has ` +
            `run past both locks and is waiting at the write the row lock exists to precede`,
        ).toMatch(/for update|pg_advisory_xact_lock/i);
      }

      expect(
        parkedStatements.some((row) => /for update/i.test(row.query ?? "")),
        `no racer is parked on the target's row lock: the writing transaction is not taking the row ` +
          `with \`for update\` before the checks it protects`,
      ).toBe(true);

      // Storage runs after the rehearsal, so a racer parked in its rehearsal cannot have deleted
      // anything yet — a claim the barrier makes observable rather than merely stated.
      expect(r2.deleted).toEqual([]);
    });

    const results = await race!;

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const refusal = (rejected[0] as PromiseRejectedResult).reason;

    expect(refusal).toBeInstanceOf(DeidentificationError);
    expect((refusal as DeidentificationError).code).toBe("deidentify_already_done");
    expect((refusal as DeidentificationError).status).toBe(409);

    const surviving = await control.sql<{ status: string }[]>`
      select status from users where id = ${target}`;

    expect(surviving.length).toBe(1);
    expect(surviving[0]!.status).toBe("deactivated");

    const audit = await control.sql<{ n: number }[]>`
      select count(*)::int as n from platform_ops_audit_logs
      where target_user_id = ${target} and event_type = 'account_deidentified'`;

    expect(audit[0]!.n, "the losing racer wrote an audit row of its own").toBe(1);
  }, 60_000);

  /**
   * The owner count is a count of OTHER rows, so the row lock above cannot serialize it: two
   * transactions that each revoke a different co-owner's membership never touch the same row. What
   * serializes them is the institution-keyed advisory lock
   * (`@/server/institution-members/owner-membership-lock`), and these two tests are what makes it
   * observable.
   *
   * THE BARRIER TAKES THAT LOCK'S KEY ITSELF. It has to: an advisory lock cannot be released
   * transaction-scoped and re-taken, and the property under test is that a racer STOPS at the lock —
   * before the count it protects. A racer parked on the advisory lock is that observation; a racer
   * that runs past it is the defect, and it is the same defect whether the call was removed or moved.
   */
  const OWNER_MEMBERSHIP_LOCK_NAMESPACE = "inst_owner_membership:";

  const parkOnOwnerMembershipLock = async (
    institutionId: string,
    launch: () => Promise<PromiseSettledResult<unknown>[]>,
  ): Promise<PromiseSettledResult<unknown>[]> => {
    const barrierPid = await backendPidOf(barrier);
    let race: Promise<PromiseSettledResult<unknown>[]> | undefined;

    await barrier.sql.begin(async (tx) => {
      await tx.unsafe(`select pg_advisory_xact_lock(hashtext($1))`, [
        `${OWNER_MEMBERSHIP_LOCK_NAMESPACE}${institutionId}`,
      ]);

      const racerPids = [await backendPidOf(racerOne), await backendPidOf(racerTwo)];

      race = launch();

      // PARKED means blocked, transitively, by the barrier's own backend. A racer that never takes
      // the lock runs straight past it and is never blocked at all, so this poll running out is the
      // failure that names the missing call.
      const blockers = await chainsOnceParked(racerPids, barrierPid);

      for (const [index, chain] of blockers.entries()) {
        expect(
          chain,
          `racer ${index + 1} never parked on the institution's owner-membership lock: the operation ` +
            `is not taking it, or is taking it after the owner count it protects`,
        ).toContain(barrierPid);
      }

      // WHICH STATEMENT IS BLOCKED, not merely that one is — the same distinction the row-lock test
      // above had to make, and for the same reason: a racer blocked anywhere downstream of the
      // barrier still reports it, so only the parked statement itself says the racer stopped AT the
      // lock rather than after the count.
      const parkedStatements = await parkedStatementsOf(racerPids);

      for (const row of parkedStatements) {
        expect(
          row.query ?? "",
          `a racer is parked on \`${row.query}\` rather than on the institution's owner-membership ` +
            `lock: the operation is not taking it before the owner count it protects`,
        ).toMatch(/pg_advisory_xact_lock/);
      }

      // The de-identification deletes objects between its rehearsal and its commit, so a racer parked
      // in its rehearsal cannot have deleted anything yet — a claim the barrier makes observable
      // rather than merely stated.
      expect(r2.deleted, "a racer deleted objects before the lock it should be parked on").toEqual(
        [],
      );
    });

    return race!;
  };

  it("lets exactly one of two co-owners be de-identified, and refuses the other", async () => {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const operator = randomUUID();
    const ownerOne = randomUUID();
    const ownerTwo = randomUUID();
    const institution = randomUUID();
    const ownerOneUsername = `${MARKER}_one_${suffix}`;
    const ownerTwoUsername = `${MARKER}_two_${suffix}`;

    await control.db.insert(schema.users).values([
      {
        id: operator,
        email: `${MARKER}-ops2-${suffix}@example.test`,
        username: `${MARKER}_ops2_${suffix}`,
        name: "Race Operator",
        role: "platform_ops",
        candidateVerifiedAt: new Date(),
      },
      {
        id: ownerOne,
        email: `${MARKER}-one-${suffix}@example.test`,
        username: ownerOneUsername,
        name: "Owner One",
        candidateVerifiedAt: new Date(),
      },
      {
        id: ownerTwo,
        email: `${MARKER}-two-${suffix}@example.test`,
        username: ownerTwoUsername,
        name: "Owner Two",
        candidateVerifiedAt: new Date(),
      },
    ]);

    // Two owners and nobody else: each of them is the last owner only if the other's membership is
    // gone, which is exactly the state the missing lock makes reachable.
    await control.db.insert(schema.institutions).values({
      id: institution,
      slug: `${MARKER}-${suffix}`,
      institutionType: "company",
      displayName: "Race Institution",
      status: "active",
    });

    await control.db.insert(schema.institutionMemberships).values([
      {
        id: randomUUID(),
        institutionId: institution,
        userId: ownerOne,
        membershipRole: "institution_owner",
        status: "active",
      },
      {
        id: randomUUID(),
        institutionId: institution,
        userId: ownerTwo,
        membershipRole: "institution_owner",
        status: "active",
      },
    ]);

    r2.objects = [`avatars/${ownerOne}/a.jpg`, `avatars/${ownerTwo}/a.jpg`];
    r2.deleted = [];

    const results = await parkOnOwnerMembershipLock(institution, () =>
      Promise.allSettled([
        deidentifyAccount(
          operator,
          ownerOne,
          { confirmUsername: ownerOneUsername, reason: "permintaan pemilik" },
          racerOne.db,
        ),
        deidentifyAccount(
          operator,
          ownerTwo,
          { confirmUsername: ownerTwoUsername, reason: "permintaan pemilik" },
          racerTwo.db,
        ),
      ]),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const refusal = (rejected[0] as PromiseRejectedResult).reason;

    expect(refusal).toBeInstanceOf(DeidentificationError);
    expect((refusal as DeidentificationError).code).toBe("deidentify_last_owner");
    expect((refusal as DeidentificationError).status).toBe(409);

    const owners = await control.sql<{ n: number }[]>`
      select count(*)::int as n from institution_memberships
      where institution_id = ${institution}
        and membership_role = 'institution_owner'
        and status = 'active'`;

    expect(owners[0]!.n, "the institution was left with no active owner").toBe(1);
  }, 60_000);

  it("refuses whichever of a de-identification and a demotion would leave the institution ownerless", async () => {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const operator = randomUUID();
    const ownerOne = randomUUID();
    const ownerTwo = randomUUID();
    const staff = randomUUID();
    const institution = randomUUID();
    const slug = `${MARKER}-both-${suffix}`;
    const ownerOneUsername = `${MARKER}_both1_${suffix}`;
    const ownerTwoMembership = randomUUID();

    await control.db.insert(schema.users).values([
      {
        id: operator,
        email: `${MARKER}-ops3-${suffix}@example.test`,
        username: `${MARKER}_ops3_${suffix}`,
        name: "Race Operator",
        role: "platform_ops",
        candidateVerifiedAt: new Date(),
      },
      {
        id: ownerOne,
        email: `${MARKER}-both1-${suffix}@example.test`,
        username: ownerOneUsername,
        name: "Owner One",
        candidateVerifiedAt: new Date(),
        recruiterVerifiedAt: new Date(),
        recruiterVerificationTier: "minimal",
      },
      {
        id: ownerTwo,
        email: `${MARKER}-both2-${suffix}@example.test`,
        username: `${MARKER}_both2_${suffix}`,
        name: "Owner Two",
        candidateVerifiedAt: new Date(),
        recruiterVerifiedAt: new Date(),
        recruiterVerificationTier: "minimal",
      },
      {
        id: staff,
        email: `${MARKER}-staff-${suffix}@example.test`,
        username: `${MARKER}_staff_${suffix}`,
        name: "Staff",
        candidateVerifiedAt: new Date(),
        recruiterVerifiedAt: new Date(),
        recruiterVerificationTier: "minimal",
      },
    ]);

    await control.db.insert(schema.institutions).values({
      id: institution,
      slug,
      institutionType: "company",
      displayName: "Race Institution",
      status: "active",
    });

    await control.db.insert(schema.institutionMemberships).values([
      {
        id: randomUUID(),
        institutionId: institution,
        userId: ownerOne,
        membershipRole: "institution_owner",
        status: "active",
      },
      {
        id: ownerTwoMembership,
        institutionId: institution,
        userId: ownerTwo,
        membershipRole: "institution_owner",
        status: "active",
      },
      {
        id: randomUUID(),
        institutionId: institution,
        userId: staff,
        membershipRole: "institution_staff",
        status: "active",
      },
    ]);

    r2.objects = [`avatars/${ownerOne}/a.jpg`];
    r2.deleted = [];

    const results = await parkOnOwnerMembershipLock(institution, () =>
      Promise.allSettled([
        deidentifyAccount(
          operator,
          ownerOne,
          { confirmUsername: ownerOneUsername, reason: "permintaan pemilik" },
          racerOne.db,
        ),
        changeMemberRole(staff, slug, ownerTwoMembership, "institution_staff", racerTwo.db),
      ]),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results
      .filter((result) => result.status === "rejected")
      .map((result) => (result as PromiseRejectedResult).reason);

    // WHICH operation loses is a coin toss and the test does not pretend otherwise: the advisory lock
    // orders the two, and either order leaves the other one looking at a single remaining owner. What
    // is not a coin toss is that exactly one of them is refused, by the code it already had, and that
    // the institution still has an owner afterwards.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const refusal = rejected[0];

    expect(
      (refusal instanceof DeidentificationError && refusal.code === "deidentify_last_owner") ||
        (refusal instanceof MemberError && refusal.code === "last_owner_demotion_forbidden"),
      `the losing operation was refused for the wrong reason: ${String(refusal)}`,
    ).toBe(true);

    const owners = await control.sql<{ n: number }[]>`
      select count(*)::int as n from institution_memberships
      where institution_id = ${institution}
        and membership_role = 'institution_owner'
        and status = 'active'`;

    expect(owners[0]!.n, "the institution was left with no active owner").toBe(1);
  }, 60_000);

  /**
   * THE GAP BETWEEN THE REHEARSAL AND THE COMMIT IS THE SEAM, and it is the only one available.
   *
   * The two tests below are both about an operation that arrives while a de-identification is
   * running, and what makes them deterministic is that the run is stopped in a place the test can
   * stand: its rehearsal has finished, so it holds neither the target's row nor any institution's
   * owner-membership lock, and it has not yet opened the transaction that commits. Nothing outside
   * the run can observe that moment — a sleep would be a guess, and the guess is the flake — but the
   * storage stage is where the run is guaranteed to be, and the mocked `deleteObject` above is what
   * holds it there.
   *
   * The barrier then takes `holdStatement` and the gate is released, so the run's commit transaction
   * queues on the barrier. `second` is launched only once that has happened, which puts it behind
   * the run rather than beside it: whichever lock is held, the queue is FIFO, and the assertion the
   * tests turn on is the statement the second operation is parked ON.
   */
  const raceAgainstTheCommit = async (options: {
    holdStatement: string;
    holdParams: string[];
    /** The de-identification, launched by this helper before the barrier takes `holdStatement`. */
    launchHeld: () => Promise<unknown>;
    /** The operation that arrives while the run waits to commit. */
    launchSecond: () => Promise<unknown>;
  }): Promise<{
    held: PromiseSettledResult<unknown>;
    second: PromiseSettledResult<unknown>;
    /** The statement `second` was parked on, read from `pg_stat_activity` while it was parked. */
    parkedOn: string;
  }> => {
    let releaseGate = (): void => {};
    r2.storageGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    let reachedStorage = (): void => {};
    const inStorage = new Promise<void>((resolve) => {
      reachedStorage = resolve;
    });
    r2.onStorage = reachedStorage;

    const barrierPid = await backendPidOf(barrier);
    const heldPid = await backendPidOf(racerOne);
    const secondPid = await backendPidOf(racerTwo);

    const held = options.launchHeld();
    // Attached at launch: an operation that refuses before it parks must not surface as an unhandled
    // rejection while the barrier is still waiting for it.
    held.catch(() => {});

    await inStorage;

    let second: Promise<unknown> = Promise.resolve();
    let parkedOn = "";

    await barrier.sql.begin(async (tx) => {
      await tx.unsafe(options.holdStatement, options.holdParams);

      releaseGate();

      const heldChains = await chainsOnceParked([heldPid], barrierPid);

      expect(
        heldChains[0],
        `the de-identification never reached \`${options.holdStatement}\` after its rehearsal: its ` +
          `committing transaction is not taking that lock`,
      ).toContain(barrierPid);

      second = options.launchSecond();
      second.catch(() => {});

      const secondChains = await chainsOnceParked([secondPid], barrierPid);

      expect(
        secondChains[0],
        `the second operation never queued behind the de-identification at ` +
          `\`${options.holdStatement}\``,
      ).toContain(barrierPid);

      // Recorded while it is parked, and asserted by the caller against its own lock: an operation
      // blocked anywhere downstream of the barrier still reports being blocked, so only the parked
      // statement says it stopped AT the lock rather than after the read the lock protects.
      const [row] = await parkedStatementsOf([secondPid]);
      parkedOn = row?.query ?? "";
    });

    return {
      held: (await Promise.allSettled([held]))[0]!,
      second: (await Promise.allSettled([second]))[0]!,
      parkedOn,
    };
  };

  it("refuses an operator's unsuspend that arrives while the account is being de-identified", async () => {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const operator = randomUUID();
    const target = randomUUID();
    const institution = randomUUID();
    const targetUsername = `${MARKER}_susp_${suffix}`;

    await control.db.insert(schema.users).values([
      {
        id: operator,
        email: `${MARKER}-suspops-${suffix}@example.test`,
        username: `${MARKER}_suspops_${suffix}`,
        name: "Race Operator",
        role: "platform_ops",
        candidateVerifiedAt: new Date(),
      },
      {
        id: target,
        // Suspended, so the unsuspend has something to clear: without it the operation refuses
        // `user_not_suspended` before it reaches the transaction under test.
        email: `${MARKER}-susp-${suffix}@example.test`,
        username: targetUsername,
        name: "Race Target",
        candidateVerifiedAt: new Date(),
        suspendedAt: new Date(),
        suspensionReason: "peninjauan",
      },
    ]);

    await control.db.insert(schema.institutions).values({
      id: institution,
      slug: `${MARKER}-susp-${suffix}`,
      institutionType: "company",
      displayName: "Race Institution",
      status: "active",
    });

    await control.db.insert(schema.institutionMemberships).values([
      {
        id: randomUUID(),
        institutionId: institution,
        userId: operator,
        membershipRole: "institution_owner",
        status: "active",
      },
      {
        id: randomUUID(),
        institutionId: institution,
        userId: target,
        membershipRole: "institution_member",
        status: "active",
      },
    ]);

    r2.objects = [`avatars/${target}/a.jpg`];
    r2.deleted = [];

    const { held, second, parkedOn } = await raceAgainstTheCommit({
      holdStatement: `select id from users where id = $1 for update`,
      holdParams: [target],
      launchHeld: () =>
        deidentifyAccount(
          operator,
          target,
          { confirmUsername: targetUsername, reason: "permintaan pemilik" },
          racerOne.db,
        ),
      launchSecond: () => unsuspendUser(operator, target, "banding diterima", racerTwo.db),
    });

    expect(held.status).toBe("fulfilled");

    // THE GUARD'S READ TAKES THE ROW, and this is the assertion that says so. The unsuspend reaches
    // its transaction while the row is locked by a de-identification whose commit is queued ahead of
    // it; a read that takes the row re-reads it once that commit lands and refuses, and a read that
    // does not takes its answer from the snapshot it was given and then waits at its own UPDATE.
    expect(
      parkedOn,
      `the unsuspend was parked on \`${parkedOn}\` rather than on the deactivated guard's own ` +
        `locking read of the account: the guard is not taking the row`,
    ).toMatch(/for update/i);

    expect(second.status).toBe("rejected");

    const refusal = (second as PromiseRejectedResult).reason;

    expect(refusal).toBeInstanceOf(ModerationError);
    expect((refusal as ModerationError).code).toBe("account_deactivated");
    expect((refusal as ModerationError).status).toBe(409);

    const [surviving] = await control.sql<{ status: string; suspended_at: Date | null }[]>`
      select status, suspended_at from users where id = ${target}`;

    expect(surviving!.status).toBe("deactivated");
    // Cleared by the unsuspend is the harm: the account would read as reachable again on a surface
    // that keys off the suspension alone.
    expect(surviving!.suspended_at, "the de-identified account was left unsuspended").not.toBeNull();
    expect(r2.deleted).toEqual([`avatars/${target}/a.jpg`]);
  }, 60_000);

  it("refuses a membership removal that arrives while the same institution's owner is de-identified", async () => {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const operator = randomUUID();
    const owner = randomUUID();
    const remover = randomUUID();
    const institution = randomUUID();
    const slug = `${MARKER}-rm-${suffix}`;
    const ownerUsername = `${MARKER}_rm_${suffix}`;
    const ownerMembership = randomUUID();

    await control.db.insert(schema.users).values([
      {
        id: operator,
        email: `${MARKER}-rmops-${suffix}@example.test`,
        username: `${MARKER}_rmops_${suffix}`,
        name: "Race Operator",
        role: "platform_ops",
        candidateVerifiedAt: new Date(),
      },
      {
        id: owner,
        email: `${MARKER}-rm-${suffix}@example.test`,
        username: ownerUsername,
        name: "Owner To Remove",
        candidateVerifiedAt: new Date(),
        recruiterVerifiedAt: new Date(),
        recruiterVerificationTier: "minimal",
      },
      {
        id: remover,
        email: `${MARKER}-rmactor-${suffix}@example.test`,
        username: `${MARKER}_rmactor_${suffix}`,
        name: "Removing Owner",
        candidateVerifiedAt: new Date(),
        recruiterVerifiedAt: new Date(),
        recruiterVerificationTier: "minimal",
      },
    ]);

    // Two owners, so the removal is allowed while it runs and the institution is never left
    // ownerless — the last-owner refusal is the other test's subject, not this one's.
    await control.db.insert(schema.institutions).values({
      id: institution,
      slug,
      institutionType: "company",
      displayName: "Race Institution",
      status: "active",
    });

    await control.db.insert(schema.institutionMemberships).values([
      {
        id: ownerMembership,
        institutionId: institution,
        userId: owner,
        membershipRole: "institution_owner",
        status: "active",
      },
      {
        id: randomUUID(),
        institutionId: institution,
        userId: remover,
        membershipRole: "institution_owner",
        status: "active",
      },
    ]);

    r2.objects = [`avatars/${owner}/a.jpg`];
    r2.deleted = [];

    const { held, second, parkedOn } = await raceAgainstTheCommit({
      holdStatement: `select pg_advisory_xact_lock(hashtext($1))`,
      holdParams: [`${OWNER_MEMBERSHIP_LOCK_NAMESPACE}${institution}`],
      launchHeld: () =>
        deidentifyAccount(
          operator,
          owner,
          { confirmUsername: ownerUsername, reason: "permintaan pemilik" },
          racerOne.db,
        ),
      launchSecond: () => removeMember(remover, slug, ownerMembership, racerTwo.db),
    });

    // The de-identification wins the queue, so the removal is the operation that has to answer for
    // the state it finds: the membership it was called for is no longer active.
    expect(held.status).toBe("fulfilled");
    expect(parkedOn).toMatch(/pg_advisory_xact_lock/);

    expect(second.status).toBe("rejected");

    const refusal = (second as PromiseRejectedResult).reason;

    // The refusal is the removal's own, and that is the deadlock assertion as much as the outcome
    // assertion: a 40P01 would have to arrive as the Postgres error it is, on one of these two
    // settled promises, and neither carries one. Both writers take the institution's lock and the
    // account's row in the same order, so the pair cannot end up holding one each and waiting.
    expect(refusal).toBeInstanceOf(MemberError);
    expect((refusal as MemberError).code).toBe("member_not_found");

    const owners = await control.sql<{ n: number }[]>`
      select count(*)::int as n from institution_memberships
      where institution_id = ${institution}
        and membership_role = 'institution_owner'
        and status = 'active'`;

    expect(owners[0]!.n, "the institution was left with no active owner").toBe(1);
  }, 60_000);
});
