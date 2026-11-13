// @vitest-environment node
//
// THE CLOSE CHECK'S RACES A ROLLED-BACK TEST CANNOT RUN.
//
// team-close-check-db.integration.test.ts runs everything in one transaction it always rolls back.
// That cannot show two runs contending: a second connection cannot see uncommitted rows, and one
// connection cannot wait on itself. So this file COMMITS, and deletes what it wrote.
//
// BARRIERED, NOT SLEEP-TIMED. A third connection takes the competition participation lock, or the
// team row, first. Each racer is then launched and confirmed PARKED behind it by reading
// pg_blocking_pids, with a deadline. Only when every racer is provably queued is the barrier
// released, so each ordering is run deliberately rather than sampled.
//
// A lock that is deleted does not make these tests flaky, it makes them fail: the run never reaches
// the barrier and the poll runs out. A lock moved below the read it protects, or a compare-and-set
// moved into a read before its write, lets both runs act, and the assertion on the outcomes goes red.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  institutions,
  teamInvitations,
  teamMemberships,
  teams,
  users,
} from "@/server/db/schema";
import { hashToken } from "@/server/teams/team-core";
import {
  remindCaptainsBeforeClose,
  settleTeamsAtRegistrationClose,
  type TeamsSettledAtClose,
} from "@/server/teams/team-close-check-service";

const enqueueSpies = vi.hoisted(() => ({
  enqueueTeamJoinReminder: vi.fn(),
  enqueueTeamCancelledBelowMinimum: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, ...enqueueSpies };
});

// Every row this file creates carries this marker in a slug, a username or an email. The sweep at
// `beforeAll` removes what a run that was killed left behind, and the same sweep runs at the end.
const MARKER = "closerace";

const DAY_MS = 24 * 60 * 60 * 1000;

const BARRIER_TIMEOUT_MS = 5_000;
const BARRIER_POLL_MS = 5;

// The close and the reminder window sit in 2020 so this harness's team is the only one the reminder
// run can select. remindCaptainsBeforeClose is global by construction: it reads every registered
// team whose close falls within 24 hours after the time it is given. Dating the fixture into the
// past makes that a property of the clock, and the reminder race checks it before it runs.
const CLOSE_AT = new Date("2020-01-01T00:00:00.000Z");
const CLOSE_RUN_AT = new Date("2020-01-01T01:00:00.000Z");
const REMINDER_RUN_AT = new Date("2020-01-01T00:00:00.000Z");
const REMINDER_CLOSE_AT = new Date("2020-01-01T12:00:00.000Z");
const REGISTERED_AT = new Date("2019-12-28T00:00:00.000Z");
const PARTICIPANT_CONFIRMATION_AT = new Date("2020-01-02T00:00:00.000Z");

type Connection = {
  label: string;
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

const openConnection = (label: string): Connection => {
  const sql = postgres(TEST_DATABASE_URL!, {
    // One connection per racer, and never recycled: a racer's queries must land on the backend whose
    // pid was captured, because that pid is what the wait graph is read against.
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
 * Everything `waiterPid` is waiting on, transitively. Postgres queues the second waiter behind the
 * first, so a direct-membership check would read a correctly formed queue as no queue at all.
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

/** Waits until `waiter` is queued behind `holder`, reading Postgres's own wait graph. */
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
    `${what} never queued behind the lock this test holds. The transitive blockers of ` +
      `${waiterPid} were last [${lastSeen.join(", ")}] and never included the holder ${holderPid}.\n` +
      `THIS IS THE GUARD-REMOVAL SIGNAL, NOT A FLAKE. The operation is expected to take that lock ` +
      `and queue behind whoever holds it. If this started failing after a change to a lock, the ` +
      `lock is what broke. Do NOT raise BARRIER_TIMEOUT_MS to make it pass.`,
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
 * failure at all. A barrier left holding a row makes the teardown's DELETE wait on it forever, so
 * an assertion failing inside the body would surface as a hung run with no message rather than as
 * a failing test.
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
 * Holds the competition participation advisory lock on the barrier connection, and runs
 * `whileHeld` in the same transaction right after taking it and before any racer is launched.
 *
 * The key is rebuilt here rather than imported so the test states the string it expects the service
 * to take. A namespace change on one side and not the other has to show up as a test that stops
 * blocking, not as two constants silently agreeing to differ.
 */
const holdParticipationLock = async <T>(
  competitionId: string,
  whileHeld: (tx: postgres.TransactionSql) => Promise<unknown>,
  body: (track: TrackRacer) => Promise<T>,
): Promise<T> => {
  const lockKey = `competition_participation:${competitionId}`;

  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => (markAcquired = resolve));
  let allowRelease!: () => void;
  const released = new Promise<void>((resolve) => (allowRelease = resolve));

  const holding = barrier.sql.begin(async (tx) => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    await whileHeld(tx);
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

const withParticipationLockHeld = <T>(
  competitionId: string,
  body: (track: TrackRacer) => Promise<T>,
): Promise<T> => holdParticipationLock(competitionId, async () => undefined, body);

// The organiser's confirmation commits when the barrier is released, so a close run that already
// queued on the lock is the one whose read of the competition decides what it sees.
const withParticipationLockHeldWhileConfirming = <T>(
  competitionId: string,
  body: (track: TrackRacer) => Promise<T>,
): Promise<T> =>
  holdParticipationLock(
    competitionId,
    (tx) =>
      tx.unsafe("update competitions set participation_confirmed_at = now() where id = $1", [
        competitionId,
      ]),
    body,
  );

const errorCodeOf = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code;

type SeededUser = { id: string; email: string; username: string };

let seedCounter = 0;
const nextSeedId = (): string => `${Date.now().toString(36)}${seedCounter++}`;

const seedUser = async (label: string): Promise<SeededUser> => {
  const username = `${MARKER}_${label}_${nextSeedId()}`;
  const email = `${username}@example.test`;
  const [row] = await control.db
    .insert(users)
    .values({
      email,
      username,
      emailVerified: new Date(),
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return { id: row!.id, email, username };
};

const seedCompetition = async (registrationEndAt: Date): Promise<{ competitionId: string }> => {
  const id = nextSeedId();

  const [institution] = await control.db
    .insert(institutions)
    .values({
      slug: `${MARKER}-inst-${id}`,
      institutionType: "company",
      displayName: `Close Race ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  const [competition] = await control.db
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `${MARKER}-comp-${id}`,
      title: `Close Race ${id}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "team",
      minTeamSize: 3,
      maxTeamSize: 3,
      status: "published",
      publishedAt: new Date("2019-12-01T00:00:00.000Z"),
      registrationStartAt: new Date("2019-12-01T00:00:00.000Z"),
      registrationEndAt,
      minimumParticipantEntries: 1,
      participantConfirmationAt: PARTICIPANT_CONFIRMATION_AT,
      eventStartAt: new Date(Date.now() + 30 * DAY_MS),
      eventEndAt: new Date(Date.now() + 31 * DAY_MS),
      resultAnnouncementAt: new Date(Date.now() + 40 * DAY_MS),
      feeAmount: null,
    })
    .returning({ id: competitions.id });

  return { competitionId: competition!.id };
};

/**
 * Seeds a registered team of the captain and Budi, COMMITTED. Committed on purpose: a second
 * connection cannot contend over a row it cannot see, so rollback isolation would make these tests
 * vacuous. The minimum is 3, so the team is one short.
 */
const seedRegisteredTeam = async (input: {
  registrationEndAt: Date;
  withUnansweredInvitation: boolean;
}): Promise<{
  competitionId: string;
  teamId: string;
  captain: SeededUser;
  budi: SeededUser;
  invitationId: string | null;
}> => {
  const { competitionId } = await seedCompetition(input.registrationEndAt);
  const captain = await seedUser("captain");
  const budi = await seedUser("budi");

  const [team] = await control.db
    .insert(teams)
    .values({
      competitionId,
      captainId: captain.id,
      name: `Tim ${nextSeedId()}`,
      status: "submitted",
    })
    .returning({ id: teams.id });

  await control.db.insert(teamMemberships).values([
    { teamId: team!.id, userId: captain.id, role: "captain", status: "active" },
    { teamId: team!.id, userId: budi.id, role: "member", status: "active" },
  ]);

  await control.db.insert(competitionRegistrations).values(
    [captain, budi].map((user) => ({
      competitionId,
      studentId: user.id,
      teamId: team!.id,
      registrationType: "team" as const,
      status: "confirmed" as const,
      registeredAt: REGISTERED_AT,
    })),
  );

  let invitationId: string | null = null;
  if (input.withUnansweredInvitation) {
    const [invitation] = await control.db
      .insert(teamInvitations)
      .values({
        teamId: team!.id,
        invitedByUserId: captain.id,
        invitedEmail: `${MARKER}_sari_${nextSeedId()}@example.test`,
        targetUserId: null,
        tokenHash: hashToken(randomUUID()),
        status: "pending_claim",
        expiresAt: input.registrationEndAt,
      })
      .returning({ id: teamInvitations.id });
    invitationId = invitation!.id;
  }

  return { competitionId, teamId: team!.id, captain, budi, invitationId };
};

const teamStatus = async (teamId: string) => {
  const [row] = await control.db
    .select({ status: teams.status })
    .from(teams)
    .where(eq(teams.id, teamId));
  return row!.status;
};

const activeMemberIds = async (teamId: string): Promise<string[]> => {
  const rows = await control.db
    .select({ userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")));
  return rows.map((row) => row.userId).sort();
};

const registrationsOfTeam = async (teamId: string) =>
  control.db
    .select({
      id: competitionRegistrations.id,
      studentId: competitionRegistrations.studentId,
      status: competitionRegistrations.status,
      cancellationReason: competitionRegistrations.cancellationReason,
    })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.teamId, teamId));

const invitationStatus = async (invitationId: string) => {
  const [row] = await control.db
    .select({ status: teamInvitations.status })
    .from(teamInvitations)
    .where(eq(teamInvitations.id, invitationId));
  return row!.status;
};

const participationConfirmedAtOf = async (competitionId: string): Promise<Date | null> => {
  const [row] = await control.db
    .select({ participationConfirmedAt: competitions.participationConfirmedAt })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row!.participationConfirmedAt;
};

const reminderMarkerEqualsClose = async (teamId: string): Promise<boolean | null> => {
  const rows = await control.sql<{ same: boolean | null }[]>`
    select t.join_reminder_close_at = c.registration_end_at as same
      from teams t join competitions c on c.id = t.competition_id
      where t.id = ${teamId}`;
  return rows[0]?.same ?? null;
};

/**
 * Deletes every row any run of this file has ever created, matched by marker rather than by id, so
 * it also removes what a CRASHED run left behind. Ordered by foreign key so each delete is legal.
 */
const purgeMarkedRows = async (): Promise<void> => {
  const slug = `${MARKER}-%`;
  const username = `${MARKER}_%`;

  await control.sql`
    delete from team_invitations where team_id in
      (select t.id from teams t join competitions c on c.id = t.competition_id
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
  await control.sql`delete from competitions where slug like ${slug}`;
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
    select 'team_invitations' as table_name, count(*) as count from team_invitations i
      join teams t on t.id = i.team_id
      join competitions c on c.id = t.competition_id where c.slug like ${slug}
    union all
    select 'competition_registrations', count(*) from competition_registrations r
      join competitions c on c.id = r.competition_id where c.slug like ${slug}
    union all
    select 'team_memberships', count(*) from team_memberships m
      join teams t on t.id = m.team_id
      join competitions c on c.id = t.competition_id where c.slug like ${slug}
    union all
    select 'teams', count(*) from teams t
      join competitions c on c.id = t.competition_id where c.slug like ${slug}
    union all
    select 'competitions', count(*) from competitions where slug like ${slug}
    union all
    select 'institution_memberships', count(*) from institution_memberships m
      join institutions i on i.id = m.institution_id where i.slug like ${slug}
    union all
    select 'institutions', count(*) from institutions where slug like ${slug}
    union all
    select 'users', count(*) from users where username like ${username}`;

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

  // A teardown that WAITS on a stray lock is worse than one that fails: the run hangs with no
  // message. A bounded wait turns that into a named error. The racers deliberately have no such
  // timeout, because waiting on the barrier is their whole job.
  await control.sql.unsafe("set lock_timeout = '10s'");

  await purgeMarkedRows();

  process.on("SIGINT", purgeOnSignal);
  process.on("SIGTERM", purgeOnSignal);
});

afterEach(async () => {
  if (skipWithoutDatabase) return;
  // In `afterEach` so an assertion failing mid-test cannot skip the cleanup of rows already committed.
  await purgeMarkedRows();
  enqueueSpies.enqueueTeamJoinReminder.mockReset();
  enqueueSpies.enqueueTeamCancelledBelowMinimum.mockReset();
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
    // Connections close whether or not the survivor assertion passed.
    await Promise.all([
      control?.sql.end(),
      barrier?.sql.end(),
      racerOne?.sql.end(),
      racerTwo?.sql.end(),
    ]);
  }
});

const readyEnqueueSpies = () => {
  enqueueSpies.enqueueTeamJoinReminder.mockResolvedValue({});
  enqueueSpies.enqueueTeamCancelledBelowMinimum.mockResolvedValue({});
};

const describeSettledRun = (outcome: Settled<TeamsSettledAtClose>): string =>
  outcome.ok
    ? `cancelled ${outcome.value.cancelledTeams.length}, closed ${outcome.value.closedInvitationCount}`
    : `rejected ${errorCodeOf(outcome.error)}`;

const describeReminderRun = (outcome: Settled<number>): string =>
  outcome.ok ? `marked ${outcome.value}` : `rejected ${errorCodeOf(outcome.error)}`;

describe.skipIf(skipWithoutDatabase)("the registration close under real contention", () => {
  it("two close runs at once cancel a short team once", async () => {
    readyEnqueueSpies();
    // No invitation, so no invite row lock orders the two runs and only the participation lock does.
    const { competitionId, teamId, captain, budi } = await seedRegisteredTeam({
      registrationEndAt: CLOSE_AT,
      withUnansweredInvitation: false,
    });
    const [barrierPid, onePid, twoPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [first, second] = await withParticipationLockHeld(competitionId, async (track) => {
      const firstRun = track(
        settleTeamsAtRegistrationClose(competitionId, CLOSE_RUN_AT, racerOne.db as never),
      );
      await awaitBlockedBy(onePid, barrierPid, "the first close run");

      const secondRun = track(
        settleTeamsAtRegistrationClose(competitionId, CLOSE_RUN_AT, racerTwo.db as never),
      );
      await awaitBlockedBy(twoPid, barrierPid, "the second close run");

      return [firstRun, secondRun] as const;
    }).then(async ([firstRun, secondRun]) => [await firstRun, await secondRun] as const);

    expect([first, second].map(describeSettledRun).sort()).toEqual([
      "cancelled 0, closed 0",
      "cancelled 1, closed 0",
    ]);

    const registrations = await registrationsOfTeam(teamId);
    const cancellingRun = [first, second].find(
      (outcome) => outcome.ok && outcome.value.cancelledTeams.length === 1,
    );
    expect(cancellingRun?.ok).toBe(true);
    if (!cancellingRun?.ok) return;
    const [cancelledTeam] = cancellingRun.value.cancelledTeams;
    expect(cancelledTeam?.teamId).toBe(teamId);
    expect(cancelledTeam?.memberCount).toBe(2);
    expect(cancelledTeam?.minTeamSize).toBe(3);
    expect(cancelledTeam?.registrations.map((registration) => registration.id).sort()).toEqual(
      registrations.map((registration) => registration.id).sort(),
    );
    expect(
      cancelledTeam?.registrations.map((registration) => registration.studentId).sort(),
    ).toEqual([captain.id, budi.id].sort());

    expect(await teamStatus(teamId)).toBe("forming");
    expect(await activeMemberIds(teamId)).toEqual([captain.id, budi.id].sort());
    expect(registrations).toHaveLength(2);
    for (const registration of registrations) {
      expect(registration.status).toBe("cancelled");
      expect(registration.cancellationReason).toBe("team_below_minimum_at_close");
    }
  });

  it("a close run that waits while the organiser confirms participation cancels no team", async () => {
    readyEnqueueSpies();
    const { competitionId, teamId, invitationId } = await seedRegisteredTeam({
      registrationEndAt: CLOSE_AT,
      withUnansweredInvitation: true,
    });
    const [barrierPid, onePid] = await Promise.all([backendPidOf(barrier), backendPidOf(racerOne)]);

    const [outcome] = await withParticipationLockHeldWhileConfirming(
      competitionId,
      async (track) => {
        const run = track(
          settleTeamsAtRegistrationClose(competitionId, CLOSE_RUN_AT, racerOne.db as never),
        );
        await awaitBlockedBy(onePid, barrierPid, "the close run");

        return [run] as const;
      },
    ).then(async ([run]) => [await run] as const);

    expect(outcome.ok, "the close run threw").toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({
      competitionId,
      closedInvitationCount: 1,
      cancelledTeams: [],
    });
    expect(await participationConfirmedAtOf(competitionId)).not.toBeNull();
    expect(await teamStatus(teamId)).toBe("submitted");
    const registrations = await registrationsOfTeam(teamId);
    expect(registrations.map((registration) => registration.status)).toEqual([
      "confirmed",
      "confirmed",
    ]);
    expect(await invitationStatus(invitationId!)).toBe("cancelled");
  });

  it("two reminder runs at once remind the captain once", async () => {
    readyEnqueueSpies();
    const { competitionId, teamId } = await seedRegisteredTeam({
      registrationEndAt: REMINDER_CLOSE_AT,
      withUnansweredInvitation: false,
    });

    // The reminder run is global, so this fixture must be the only team it can select.
    // Strings rather than Dates: drizzle replaces this client's timestamp serializers with a
    // pass-through, so a Date parameter on it is refused.
    const windowStart = REMINDER_RUN_AT.toISOString();
    const windowEnd = new Date(REMINDER_RUN_AT.getTime() + DAY_MS).toISOString();
    const [inWindow] = await control.sql<{ count: string }[]>`
      select count(*) as count from teams t
        join competitions c on c.id = t.competition_id
        where c.registration_end_at > ${windowStart}::timestamptz
          and c.registration_end_at <= ${windowEnd}::timestamptz`;
    expect(Number(inWindow!.count)).toBe(1);

    const [barrierPid, onePid, twoPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [first, second] = await withRowHeld("teams", teamId, async (track) => {
      const firstRun = track(remindCaptainsBeforeClose(REMINDER_RUN_AT, racerOne.db as never));
      await awaitBlockedBy(onePid, barrierPid, "the first reminder run");

      const secondRun = track(remindCaptainsBeforeClose(REMINDER_RUN_AT, racerTwo.db as never));
      await awaitBlockedBy(twoPid, barrierPid, "the second reminder run");

      return [firstRun, secondRun] as const;
    }).then(async ([firstRun, secondRun]) => [await firstRun, await secondRun] as const);

    expect([first, second].map(describeReminderRun).sort()).toEqual(["marked 0", "marked 1"]);

    expect(enqueueSpies.enqueueTeamJoinReminder).toHaveBeenCalledTimes(1);
    expect(enqueueSpies.enqueueTeamJoinReminder).toHaveBeenCalledWith({
      teamId,
      competitionId,
      closesAt: REMINDER_CLOSE_AT,
    });
    expect(await reminderMarkerEqualsClose(teamId)).toBe(true);
  });
});
