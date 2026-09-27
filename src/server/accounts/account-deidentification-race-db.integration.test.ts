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

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const r2 = vi.hoisted(() => ({ objects: [] as string[], deleted: [] as string[] }));

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => true,
  listObjects: async (prefix: string) =>
    r2.objects.filter((key) => key.startsWith(prefix)).map((key) => ({ key, lastModified: null })),
  deleteObject: async (key: string) => {
    r2.deleted.push(key);

    const at = r2.objects.indexOf(key);
    if (at !== -1) r2.objects.splice(at, 1);
  },
}));

import { deidentifyAccount, DeidentificationError } from "./account-deidentification-service";

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
      const deadline = Date.now() + BARRIER_TIMEOUT_MS;
      let blockers: number[][] = [];

      while (Date.now() < deadline) {
        blockers = await Promise.all(racerPids.map((pid) => transitiveBlockersOf(control, pid)));

        if (blockers.every((chain) => chain.includes(barrierPid))) {
          break;
        }

        await sleep(BARRIER_POLL_MS);
      }

      blockers = await Promise.all(racerPids.map((pid) => transitiveBlockersOf(control, pid)));

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
      // two: this asserts the racer stopped at the LOCK, before the checks and writes it protects,
      // which is the property `for update` is there to provide.
      const parkedStatements = await control.sql<{ pid: number; query: string | null }[]>`
        select pid, query from pg_stat_activity where pid = any(${racerPids})`;

      for (const row of parkedStatements) {
        expect(
          row.query ?? "",
          `a racer is parked on \`${row.query}\` rather than on the target's row lock: the writing ` +
            `transaction is not taking the row with \`for update\` before the checks it protects`,
        ).toMatch(/for update/i);
      }

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
});
