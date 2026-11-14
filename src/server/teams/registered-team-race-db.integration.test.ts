// @vitest-environment node
//
// THE RACES A ROLLED-BACK TEST CANNOT RUN, FOR A REGISTERED FREE TEAM.
//
// `early-team-registration-db.integration.test.ts` runs everything in one transaction it always
// rolls back. That cannot show two requests contending: a second connection cannot see uncommitted
// rows, and one connection cannot wait on itself. So this file COMMITS, and deletes what it wrote.
//
// BARRIERED, NOT SLEEP-TIMED. A third connection takes the competition participation lock first.
// Each racer is then launched and confirmed PARKED behind it by reading `pg_blocking_pids`, with a
// deadline. Only when every racer is provably queued is the barrier released, so each ordering is
// run deliberately rather than sampled. The queue order is the launch order.
//
// A lock that is deleted does not make these tests flaky, it makes them fail: the operation never
// reaches the barrier and the poll runs out. A lock moved below the check it protects lets both
// operations commit, and the assertion on the surviving state goes red.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  institutionMemberships,
  institutions,
  teamInvitations,
  teamMemberships,
  teams,
  users,
} from "@/server/db/schema";
import { setCompetitionFee } from "@/server/competitions/competition-fee-service";
import { parseCompetitionPatchInput } from "@/server/competitions/competition-core";
import {
  unpublishCompetition,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { hashToken } from "@/server/teams/team-core";
import {
  acceptTeamInvitationForUser,
  cancelTeamInvitationByToken,
  createTeam,
  declineTeamInvitationForUser,
  inviteTeamMember,
} from "@/server/teams/team-service";
import { submitTeamRegistration } from "@/server/teams/team-registration-service";

const enqueueSpies = vi.hoisted(() => ({
  enqueueTeamInvitationDispatch: vi.fn(),
  enqueueRegistrationConfirmed: vi.fn(),
  enqueueCompetitionEdited: vi.fn(),
  enqueueCompetitionCancelled: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, ...enqueueSpies };
});

// Every row this file creates carries this marker in a slug, a username or an email. The sweep at
// `beforeAll` removes what a run that was killed left behind, and the same sweep runs at the end.
const MARKER = "teamrace";

const DAY_MS = 24 * 60 * 60 * 1000;

const BARRIER_TIMEOUT_MS = 5_000;
const BARRIER_POLL_MS = 5;

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
 * Holds an exclusive lock on one invitation row for the duration of `body`, and ALWAYS gives it
 * back. When the barrier is released it marks that invitation accepted before it commits.
 *
 * The `finally` is the only reason this suite can report a failure at all: a barrier left holding
 * the row would make the teardown wait forever. Racers launched through `track` are awaited in the
 * same `finally`, so none wakes up during teardown and commits into the middle of the purge.
 */
const withInvitationAcceptedOnRelease = async <T>(
  invitationId: string,
  body: (track: TrackRacer) => Promise<T>,
): Promise<T> => {
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => (markAcquired = resolve));
  let allowRelease!: () => void;
  const released = new Promise<void>((resolve) => (allowRelease = resolve));

  const holding = barrier.sql.begin(async (tx) => {
    await tx.unsafe("select id from team_invitations where id = $1 for update", [invitationId]);
    markAcquired();
    await released;
    // Stands in for an accept that commits while the cancel waits on the row.
    await tx.unsafe(
      "update team_invitations set status = 'accepted', accepted_at = now() where id = $1",
      [invitationId],
    );
  });

  await Promise.race([
    acquired,
    holding.then(() => {
      throw new Error("the barrier transaction ended before it took the invitation row lock");
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

/**
 * Holds one competition row changed and uncommitted for the duration of `body`, then commits it.
 * A racer's plain read still sees the row as it was, and a racer's write queues on the row lock
 * until the change commits. Racers are awaited in the `finally`, as in the barriers above.
 */
const withCompetitionChangeHeld = async <T>(
  competitionId: string,
  assignments: string,
  body: (track: TrackRacer) => Promise<T>,
): Promise<T> => {
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => (markAcquired = resolve));
  let allowRelease!: () => void;
  const released = new Promise<void>((resolve) => (allowRelease = resolve));

  const holding = barrier.sql.begin(async (tx) => {
    await tx.unsafe(`update competitions set ${assignments}, updated_at = now() where id = $1`, [
      competitionId,
    ]);
    markAcquired();
    await released;
  });

  await Promise.race([
    acquired,
    holding.then(() => {
      throw new Error("the barrier transaction ended before it changed the competition row");
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

const seedOwner = async (institutionId: string): Promise<SeededUser> => {
  const username = `${MARKER}_owner_${nextSeedId()}`;
  const email = `${username}@example.test`;
  const [row] = await control.db
    .insert(users)
    .values({
      email,
      username,
      emailVerified: new Date(),
      role: "recruiter",
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    })
    .returning({ id: users.id });

  await control.db.insert(institutionMemberships).values({
    institutionId,
    userId: row!.id,
    membershipRole: "institution_owner",
    status: "active",
  });

  return { id: row!.id, email, username };
};

type CompetitionSeed = { maxTeamSize: number; paid: boolean };

const FREE_TEAM_OF_THREE: CompetitionSeed = { maxTeamSize: 3, paid: false };

const seedCompetition = async (
  seed: CompetitionSeed,
): Promise<{ competitionId: string; institutionId: string }> => {
  const id = nextSeedId();

  const [institution] = await control.db
    .insert(institutions)
    .values({
      slug: `${MARKER}-inst-${id}`,
      institutionType: "company",
      displayName: `Team Race ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  const [competition] = await control.db
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `${MARKER}-comp-${id}`,
      title: `Team Race ${id}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "team",
      minTeamSize: 3,
      maxTeamSize: seed.maxTeamSize,
      status: "published",
      publishedAt: new Date(),
      registrationStartAt: new Date(Date.now() - 7 * DAY_MS),
      registrationEndAt: new Date(Date.now() + 14 * DAY_MS),
      participantConfirmationAt: new Date(Date.now() + 20 * DAY_MS),
      eventStartAt: new Date(Date.now() + 30 * DAY_MS),
      eventEndAt: new Date(Date.now() + 31 * DAY_MS),
      resultAnnouncementAt: new Date(Date.now() + 40 * DAY_MS),
      feeAmount: seed.paid ? 150_000 : null,
      feeCurrency: seed.paid ? "IDR" : null,
    })
    .returning({ id: competitions.id });

  return { competitionId: competition!.id, institutionId: institution!.id };
};

/**
 * Seeds a team of the captain and Budi, COMMITTED. Committed on purpose: a second connection cannot
 * contend over a row it cannot see, so rollback isolation would make these tests vacuous.
 */
const seedTeam = async (
  status: "forming" | "submitted",
  seed: CompetitionSeed = FREE_TEAM_OF_THREE,
): Promise<{
  competitionId: string;
  institutionId: string;
  teamId: string;
  captain: SeededUser;
  budi: SeededUser;
}> => {
  const { competitionId, institutionId } = await seedCompetition(seed);
  const captain = await seedUser("captain");
  const budi = await seedUser("budi");

  const [team] = await control.db
    .insert(teams)
    .values({
      competitionId,
      captainId: captain.id,
      name: `Tim ${nextSeedId()}`,
      status,
    })
    .returning({ id: teams.id });

  await control.db.insert(teamMemberships).values([
    { teamId: team!.id, userId: captain.id, role: "captain", status: "active" },
    { teamId: team!.id, userId: budi.id, role: "member", status: "active" },
  ]);

  if (status === "submitted") {
    await control.db.insert(competitionRegistrations).values(
      [captain, budi].map((user) => ({
        competitionId,
        studentId: user.id,
        teamId: team!.id,
        registrationType: "team" as const,
        status: "confirmed" as const,
      })),
    );
  }

  return { competitionId, institutionId, teamId: team!.id, captain, budi };
};

const seedOpenInvitation = async (
  teamId: string,
  captainId: string,
  invitee: SeededUser,
): Promise<{ id: string; tokenHash: string }> => {
  const tokenHash = hashToken(randomUUID());
  const [row] = await control.db
    .insert(teamInvitations)
    .values({
      teamId,
      invitedByUserId: captainId,
      invitedEmail: invitee.email,
      targetUserId: invitee.id,
      tokenHash,
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
    })
    .returning({ id: teamInvitations.id });
  return { id: row!.id, tokenHash };
};

const pendingInvitationCount = async (teamId: string): Promise<number> => {
  const rows = await control.db
    .select({ id: teamInvitations.id })
    .from(teamInvitations)
    .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, "pending")));
  return rows.length;
};

const invitationStatus = async (invitationId: string) => {
  const [row] = await control.db
    .select({ status: teamInvitations.status })
    .from(teamInvitations)
    .where(eq(teamInvitations.id, invitationId));
  return row!.status;
};

const openInvitationsOf = async (teamId: string) =>
  control.db
    .select({ invitedEmail: teamInvitations.invitedEmail, expiresAt: teamInvitations.expiresAt })
    .from(teamInvitations)
    .where(
      and(
        eq(teamInvitations.teamId, teamId),
        inArray(teamInvitations.status, ["pending", "pending_claim"]),
      ),
    );

const competitionCloseAndFeeOf = async (
  competitionId: string,
): Promise<{ registrationEndAt: Date; feeAmount: number | null }> => {
  const [row] = await control.db
    .select({
      registrationEndAt: competitions.registrationEndAt,
      feeAmount: competitions.feeAmount,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return { registrationEndAt: row!.registrationEndAt!, feeAmount: row!.feeAmount };
};

const competitionRowOf = async (competitionId: string) => {
  const [row] = await control.db
    .select({
      status: competitions.status,
      slug: competitions.slug,
      maxTeamSize: competitions.maxTeamSize,
      feeAmount: competitions.feeAmount,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row!;
};

const teamStatus = async (teamId: string) => {
  const [row] = await control.db
    .select({ status: teams.status })
    .from(teams)
    .where(eq(teams.id, teamId));
  return row!.status;
};

const teamStatusesCaptainedBy = async (
  competitionId: string,
  captainId: string,
): Promise<string[]> => {
  const rows = await control.db
    .select({ status: teams.status })
    .from(teams)
    .where(and(eq(teams.competitionId, competitionId), eq(teams.captainId, captainId)));
  return rows.map((row) => row.status).sort();
};

const activeMemberIds = async (teamId: string): Promise<string[]> => {
  const rows = await control.db
    .select({ userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")));
  return rows.map((row) => row.userId).sort();
};

const confirmedRegistrationStudentIds = async (teamId: string): Promise<string[]> => {
  const rows = await control.db
    .select({ studentId: competitionRegistrations.studentId })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.teamId, teamId),
        eq(competitionRegistrations.status, "confirmed"),
      ),
    );
  return rows.map((row) => row.studentId).sort();
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
  enqueueSpies.enqueueTeamInvitationDispatch.mockReset();
  enqueueSpies.enqueueRegistrationConfirmed.mockReset();
  enqueueSpies.enqueueCompetitionEdited.mockReset();
  enqueueSpies.enqueueCompetitionCancelled.mockReset();
  enqueueSpies.enqueueCompetitionSearchSync.mockReset();
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
  enqueueSpies.enqueueTeamInvitationDispatch.mockResolvedValue({});
  enqueueSpies.enqueueRegistrationConfirmed.mockResolvedValue({});
  enqueueSpies.enqueueCompetitionEdited.mockResolvedValue({});
  enqueueSpies.enqueueCompetitionCancelled.mockResolvedValue({});
  enqueueSpies.enqueueCompetitionSearchSync.mockResolvedValue({});
};

describe.skipIf(skipWithoutDatabase)("a registered free team under real contention", () => {
  it("two invites for the last seat of a registered team: one is sent, the other is refused as full", async () => {
    readyEnqueueSpies();
    const { competitionId, teamId, captain } = await seedTeam("submitted");
    const dewi = await seedUser("dewi");
    const eko = await seedUser("eko");
    const [barrierPid, onePid, twoPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [first, second] = await withParticipationLockHeld(competitionId, async (track) => {
      const firstRun = track(
        inviteTeamMember(
          captain.id,
          teamId,
          { invitedIdentifier: dewi.username },
          racerOne.db as never,
        ),
      );
      await awaitBlockedBy(onePid, barrierPid, "the first invite");

      const secondRun = track(
        inviteTeamMember(
          captain.id,
          teamId,
          { invitedIdentifier: eko.username },
          racerTwo.db as never,
        ),
      );
      await awaitBlockedBy(twoPid, barrierPid, "the second invite");

      return [firstRun, secondRun] as const;
    }).then(async ([firstRun, secondRun]) => [await firstRun, await secondRun] as const);

    const sent = [first, second].filter((outcome) => outcome.ok);
    const refused = [first, second].filter((outcome) => !outcome.ok);
    expect(sent, "both invites were sent into the last seat").toHaveLength(1);
    expect(refused).toHaveLength(1);
    const refusal = refused[0] as { ok: false; error: unknown };
    expect(errorCodeOf(refusal.error)).toBe("team_at_capacity");
    expect(await pendingInvitationCount(teamId)).toBe(1);
  });

  it("CAPTAIN FIRST: a teammate accepting while the team registers joins with a confirmed registration", async () => {
    readyEnqueueSpies();
    const { competitionId, teamId, captain, budi } = await seedTeam("forming");
    const sari = await seedUser("sari");
    const sariInvite = await seedOpenInvitation(teamId, captain.id, sari);
    const [barrierPid, submitPid, acceptPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [submitted, accepted] = await withParticipationLockHeld(competitionId, async (track) => {
      const submitRun = track(
        submitTeamRegistration(captain.id, competitionId, teamId, racerOne.db as never),
      );
      await awaitBlockedBy(submitPid, barrierPid, "the team registration");

      const acceptRun = track(
        acceptTeamInvitationForUser(sariInvite.id, sari.id, racerTwo.db as never),
      );
      await awaitBlockedBy(acceptPid, barrierPid, "the accept");

      return [submitRun, acceptRun] as const;
    }).then(async ([submitRun, acceptRun]) => [await submitRun, await acceptRun] as const);

    expect(submitted.ok, "the registration threw").toBe(true);
    expect(accepted.ok, "the accept threw").toBe(true);
    expect(await teamStatus(teamId)).toBe("submitted");
    const everyone = [captain.id, budi.id, sari.id].sort();
    expect(await activeMemberIds(teamId)).toEqual(everyone);
    expect(await confirmedRegistrationStudentIds(teamId)).toEqual(everyone);
  });

  it("TEAMMATE FIRST: a team registering while a teammate accepts registers that teammate too", async () => {
    readyEnqueueSpies();
    const { competitionId, teamId, captain, budi } = await seedTeam("forming");
    const sari = await seedUser("sari");
    const sariInvite = await seedOpenInvitation(teamId, captain.id, sari);
    const [barrierPid, acceptPid, submitPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [accepted, submitted] = await withParticipationLockHeld(competitionId, async (track) => {
      const acceptRun = track(
        acceptTeamInvitationForUser(sariInvite.id, sari.id, racerOne.db as never),
      );
      await awaitBlockedBy(acceptPid, barrierPid, "the accept");

      const submitRun = track(
        submitTeamRegistration(captain.id, competitionId, teamId, racerTwo.db as never),
      );
      await awaitBlockedBy(submitPid, barrierPid, "the team registration");

      return [acceptRun, submitRun] as const;
    }).then(async ([acceptRun, submitRun]) => [await acceptRun, await submitRun] as const);

    expect(accepted.ok, "the accept threw").toBe(true);
    expect(submitted.ok, "the registration threw").toBe(true);
    expect(await teamStatus(teamId)).toBe("submitted");
    const everyone = [captain.id, budi.id, sari.id].sort();
    expect(await activeMemberIds(teamId)).toEqual(everyone);
    expect(await confirmedRegistrationStudentIds(teamId)).toEqual(everyone);
  });

  it("a forming accept waiting on the lock is refused when the captain cancels that invite meanwhile", async () => {
    readyEnqueueSpies();
    const { competitionId, teamId, captain, budi } = await seedTeam("forming");
    const sari = await seedUser("sari");
    const sariInvite = await seedOpenInvitation(teamId, captain.id, sari);
    const [barrierPid, acceptPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
    ]);

    const [accepted] = await withParticipationLockHeld(competitionId, async (track) => {
      // The accept has read the invite as pending by the time it queues on the lock.
      const acceptRun = track(
        acceptTeamInvitationForUser(sariInvite.id, sari.id, racerOne.db as never),
      );
      await awaitBlockedBy(acceptPid, barrierPid, "the accept");

      // The forming cancel takes no lock, so it resolves while the accept is still parked.
      await cancelTeamInvitationByToken(
        captain.id,
        teamId,
        sariInvite.tokenHash,
        racerTwo.db as never,
      );

      return [acceptRun] as const;
    }).then(async ([acceptRun]) => [await acceptRun] as const);

    expect(accepted.ok, "the accept went through a cancelled invite").toBe(false);
    if (accepted.ok) return;
    expect(errorCodeOf(accepted.error)).toBe("team_invite_not_actionable");
    expect(await invitationStatus(sariInvite.id)).toBe("cancelled");
    expect(await activeMemberIds(teamId)).toEqual([captain.id, budi.id].sort());
  });

  it("a forming cancel that waits behind an accept leaves the accepted invite in place", async () => {
    readyEnqueueSpies();
    const { teamId, captain } = await seedTeam("forming");
    const sari = await seedUser("sari");
    const sariInvite = await seedOpenInvitation(teamId, captain.id, sari);
    const [barrierPid, cancelPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
    ]);

    const [cancelled] = await withInvitationAcceptedOnRelease(sariInvite.id, async (track) => {
      // The cancel has read the invite as pending, and its update waits on the row.
      const cancelRun = track(
        cancelTeamInvitationByToken(captain.id, teamId, sariInvite.tokenHash, racerOne.db as never),
      );
      await awaitBlockedBy(cancelPid, barrierPid, "the cancel");

      return [cancelRun] as const;
    }).then(async ([cancelRun]) => [await cancelRun] as const);

    expect(cancelled.ok, "the cancel overwrote an accepted invite").toBe(false);
    if (cancelled.ok) return;
    expect(errorCodeOf(cancelled.error)).toBe("team_invite_not_actionable");
    expect(await invitationStatus(sariInvite.id)).toBe("accepted");
  });

  it("a forming invite waiting on the lock while the captain registers the team is refused, and leaves no seven-day invite on the registered team", async () => {
    readyEnqueueSpies();
    const { competitionId, teamId, captain } = await seedTeam("forming", {
      maxTeamSize: 4,
      paid: false,
    });
    const sari = await seedUser("sari");
    await seedOpenInvitation(teamId, captain.id, sari);
    const dewi = await seedUser("dewi");
    const [barrierPid, submitPid, invitePid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [submitted, invited] = await withParticipationLockHeld(competitionId, async (track) => {
      const submitRun = track(
        submitTeamRegistration(captain.id, competitionId, teamId, racerOne.db as never),
      );
      await awaitBlockedBy(submitPid, barrierPid, "the team registration");

      // The invite has read the team as forming before it queued.
      const inviteRun = track(
        inviteTeamMember(
          captain.id,
          teamId,
          { invitedIdentifier: dewi.username },
          racerTwo.db as never,
        ),
      );
      await awaitBlockedBy(invitePid, barrierPid, "the invite");

      return [submitRun, inviteRun] as const;
    }).then(async ([submitRun, inviteRun]) => [await submitRun, await inviteRun] as const);

    expect(submitted.ok, "the registration threw").toBe(true);
    expect(invited.ok, "the invite landed on a team that had just registered").toBe(false);
    if (invited.ok) return;
    expect(errorCodeOf(invited.error)).toBe("team_state_conflict");
    expect(await teamStatus(teamId)).toBe("submitted");
    const open = await openInvitationsOf(teamId);
    expect(open.map((invitation) => invitation.invitedEmail)).toEqual([sari.email]);
    const { registrationEndAt } = await competitionCloseAndFeeOf(competitionId);
    expect(open[0]!.expiresAt.getTime()).toBe(registrationEndAt.getTime());
  });

  it("a decline that waits behind an accept leaves the accepted invite in place", async () => {
    readyEnqueueSpies();
    const { teamId, captain } = await seedTeam("forming");
    const sari = await seedUser("sari");
    const sariInvite = await seedOpenInvitation(teamId, captain.id, sari);
    const [barrierPid, declinePid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
    ]);

    const [declined] = await withInvitationAcceptedOnRelease(sariInvite.id, async (track) => {
      // The decline has read the invite as pending, and its update waits on the row.
      const declineRun = track(
        declineTeamInvitationForUser(sariInvite.id, sari.id, racerOne.db as never),
      );
      await awaitBlockedBy(declinePid, barrierPid, "the decline");

      return [declineRun] as const;
    }).then(async ([declineRun]) => [await declineRun] as const);

    expect(declined.ok, "the decline overwrote an accepted invite").toBe(false);
    if (declined.ok) return;
    expect(errorCodeOf(declined.error)).toBe("team_invite_not_actionable");
    expect(await invitationStatus(sariInvite.id)).toBe("accepted");
  });

  it("refuses a fee change that waited on the participation lock while the competition was published", async () => {
    readyEnqueueSpies();
    const { competitionId, institutionId } = await seedCompetition({ maxTeamSize: 3, paid: true });
    await control.db
      .update(competitions)
      .set({ status: "draft" })
      .where(eq(competitions.id, competitionId));
    const owner = await seedOwner(institutionId);
    const [barrierPid, feePid] = await Promise.all([backendPidOf(barrier), backendPidOf(racerOne)]);

    const [feeChange] = await withParticipationLockHeld(competitionId, async (track) => {
      const feeRun = track(
        setCompetitionFee(
          owner.id,
          competitionId,
          { feeAmount: null, feeCurrency: null },
          racerOne.db as never,
        ),
      );
      await awaitBlockedBy(feePid, barrierPid, "the fee change");

      // A publish takes no participation lock, so it commits while the fee change waits.
      await control.db
        .update(competitions)
        .set({ status: "published" })
        .where(eq(competitions.id, competitionId));

      return [feeRun] as const;
    }).then(async ([feeRun]) => [await feeRun] as const);

    const { feeAmount } = await competitionCloseAndFeeOf(competitionId);
    expect({
      ok: feeChange.ok,
      code: feeChange.ok ? undefined : errorCodeOf(feeChange.error),
      feeAmount,
    }).toEqual({ ok: false, code: "competition_fee_locked_after_publish", feeAmount: 150_000 });
  });
});

describe.skipIf(skipWithoutDatabase)("a competition write racing a change to its row", () => {
  it("refuses a draft's price change whose write lands after a publish commits", async () => {
    readyEnqueueSpies();
    const { competitionId, institutionId } = await seedCompetition({ maxTeamSize: 3, paid: true });
    await control.db
      .update(competitions)
      .set({ status: "draft" })
      .where(eq(competitions.id, competitionId));
    const owner = await seedOwner(institutionId);
    const before = await competitionRowOf(competitionId);
    const [barrierPid, racerPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
    ]);

    const [outcome] = await withCompetitionChangeHeld(
      competitionId,
      "status = 'published'",
      async (track) => {
        const run = track(
          setCompetitionFee(
            owner.id,
            competitionId,
            { feeAmount: null, feeCurrency: null },
            racerOne.db as never,
          ),
        );
        await awaitBlockedBy(racerPid, barrierPid, "the fee write");
        return [run] as const;
      },
    ).then(async ([run]) => [await run] as const);

    expect({
      ok: outcome.ok,
      code: outcome.ok ? undefined : errorCodeOf(outcome.error),
      row: await competitionRowOf(competitionId),
    }).toEqual({
      ok: false,
      code: "competition_changed_during_edit",
      row: { ...before, status: "published" },
    });
  });

  it("refuses a draft edit whose write lands after a publish commits", async () => {
    readyEnqueueSpies();
    const { competitionId, institutionId } = await seedCompetition({ maxTeamSize: 3, paid: false });
    await control.db
      .update(competitions)
      .set({ status: "draft" })
      .where(eq(competitions.id, competitionId));
    const owner = await seedOwner(institutionId);
    const before = await competitionRowOf(competitionId);
    const [barrierPid, racerPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
    ]);

    const [outcome] = await withCompetitionChangeHeld(
      competitionId,
      "status = 'published'",
      async (track) => {
        const run = track(
          updateCompetitionDraft(
            owner.id,
            competitionId,
            parseCompetitionPatchInput({ slug: `${before.slug}-baru` }),
            racerOne.db as never,
          ),
        );
        await awaitBlockedBy(racerPid, barrierPid, "the draft write");
        return [run] as const;
      },
    ).then(async ([run]) => [await run] as const);

    expect({
      ok: outcome.ok,
      code: outcome.ok ? undefined : errorCodeOf(outcome.error),
      row: await competitionRowOf(competitionId),
    }).toEqual({
      ok: false,
      code: "competition_changed_during_edit",
      row: { ...before, status: "published" },
    });
  });

  it("refuses a published edit whose write lands after another edit of the row commits", async () => {
    readyEnqueueSpies();
    const { competitionId, institutionId } = await seedCompetition({ maxTeamSize: 4, paid: false });
    const owner = await seedOwner(institutionId);
    const before = await competitionRowOf(competitionId);
    const [barrierPid, racerPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
    ]);

    const [outcome] = await withCompetitionChangeHeld(
      competitionId,
      "max_team_size = 6",
      async (track) => {
        const run = track(
          updateCompetitionDraft(
            owner.id,
            competitionId,
            parseCompetitionPatchInput({ maxTeamSize: 5 }),
            racerOne.db as never,
          ),
        );
        await awaitBlockedBy(racerPid, barrierPid, "the published write");
        return [run] as const;
      },
    ).then(async ([run]) => [await run] as const);

    expect({
      ok: outcome.ok,
      code: outcome.ok ? undefined : errorCodeOf(outcome.error),
      row: await competitionRowOf(competitionId),
    }).toEqual({
      ok: false,
      code: "competition_changed_during_edit",
      row: { ...before, maxTeamSize: 6 },
    });
  });

  it("refuses a published close move whose write lands after another edit of the row commits, and moves no invite", async () => {
    readyEnqueueSpies();
    const { competitionId, institutionId, teamId, captain } = await seedTeam("submitted", {
      maxTeamSize: 4,
      paid: false,
    });
    const sari = await seedUser("sari");
    await seedOpenInvitation(teamId, captain.id, sari);
    const owner = await seedOwner(institutionId);
    const before = await competitionRowOf(competitionId);
    const invitesBefore = await openInvitationsOf(teamId);
    const [barrierPid, racerPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
    ]);

    const [outcome] = await withCompetitionChangeHeld(
      competitionId,
      "max_team_size = 6",
      async (track) => {
        const run = track(
          updateCompetitionDraft(
            owner.id,
            competitionId,
            parseCompetitionPatchInput({
              registrationEndAt: new Date(Date.now() + 17 * DAY_MS).toISOString(),
            }),
            racerOne.db as never,
          ),
        );
        await awaitBlockedBy(racerPid, barrierPid, "the published close move");
        return [run] as const;
      },
    ).then(async ([run]) => [await run] as const);

    expect({
      ok: outcome.ok,
      code: outcome.ok ? undefined : errorCodeOf(outcome.error),
      row: await competitionRowOf(competitionId),
      invites: await openInvitationsOf(teamId),
    }).toEqual({
      ok: false,
      code: "competition_changed_during_edit",
      row: { ...before, maxTeamSize: 6 },
      invites: invitesBefore,
    });
  });
});

describe.skipIf(skipWithoutDatabase)("a team created while the host unpublishes", () => {
  it("waits for the unpublish and is refused, so no team is left on the unpublished competition", async () => {
    readyEnqueueSpies();
    const { competitionId, institutionId, teamId } = await seedTeam("forming");
    const owner = await seedOwner(institutionId);
    const dewi = await seedUser("dewi");
    const [barrierPid, unpublishPid, createPid] = await Promise.all([
      backendPidOf(barrier),
      backendPidOf(racerOne),
      backendPidOf(racerTwo),
    ]);

    const [unpublish, create] = await withParticipationLockHeld(competitionId, async (track) => {
      const unpublishRun = track(
        unpublishCompetition(owner.id, competitionId, racerOne.db as never),
      );
      await awaitBlockedBy(unpublishPid, barrierPid, "the unpublish");

      const createRun = track(
        createTeam(dewi.id, competitionId, { name: `Tim ${nextSeedId()}` }, racerTwo.db as never),
      );
      await awaitBlockedBy(createPid, barrierPid, "the team creation");

      return [unpublishRun, createRun] as const;
    }).then(async ([unpublishRun, createRun]) => [await unpublishRun, await createRun] as const);

    expect({
      unpublishOk: unpublish.ok,
      createOk: create.ok,
      createCode: create.ok ? undefined : errorCodeOf(create.error),
      createStatus: create.ok ? undefined : (create.error as { status?: number }).status,
      createdTeams: await teamStatusesCaptainedBy(competitionId, dewi.id),
      seededTeam: await teamStatus(teamId),
    }).toEqual({
      unpublishOk: true,
      createOk: false,
      createCode: "team_competition_not_published",
      createStatus: 422,
      createdTeams: [],
      seededTeam: "cancelled",
    });
  });
});
