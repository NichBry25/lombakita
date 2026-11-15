// @vitest-environment node

import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
  type Mock,
} from "vitest";
import { TransactionRollbackError, and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  institutionMemberships,
  institutions,
  notifications,
  teamInvitations,
  teamMemberships,
  teams,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const dbState = vi.hoisted(() => ({
  transaction: null as Database | null,
  testRunStarted: false,
}));

const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      dbState.transaction = tx as unknown as Database;
      try {
        await body(tx);
      } finally {
        dbState.transaction = null;
      }
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (dbState.transaction) return dbState.transaction;
      if (!dbState.testRunStarted) return actual.getDb();
      throw new Error("a close check test read the database outside a test");
    },
  };
});

const enqueueSpies = vi.hoisted(() => ({
  enqueueTeamJoinReminder: vi.fn(),
  enqueueTeamCancelledBelowMinimum: vi.fn(),
  enqueueRegistrationCancelled: vi.fn(),
  enqueueRegistrationConfirmed: vi.fn(),
  enqueueTeamInvitationDispatch: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(),
  enqueueCompetitionCancelled: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, ...enqueueSpies };
});

const noticeSpies = vi.hoisted(() => ({
  sendTeamCloseNoticeEmail: vi.fn(),
}));

vi.mock("@/server/teams/team-close-notices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/teams/team-close-notices")>();
  return { ...actual, ...noticeSpies };
});

import {
  processTeamCloseCheckJob,
  type TeamCloseCheckJob,
} from "@/server/async/jobs/team-close-check";
import {
  processTeamJoinReminderJob,
  type TeamJoinReminderJob,
} from "@/server/async/jobs/team-join-reminder";
import {
  processTeamCancelledBelowMinimumJob,
  type TeamCancelledBelowMinimumJob,
} from "@/server/async/jobs/team-cancelled-below-minimum";
import {
  markJoinReminderForCurrentClose,
  settleTeamsAtRegistrationClose,
  TEAM_BELOW_MINIMUM_CANCELLATION_REASON,
} from "@/server/teams/team-close-check-service";
import {
  cancelTeamRegistration,
  revertSubmittedTeamToForming,
  submitTeamRegistration,
} from "@/server/teams/team-registration-service";
import {
  acceptTeamInvitationForUser,
  declineTeamInvitationForUser,
} from "@/server/teams/team-service";
import { unpublishCompetition } from "@/server/competitions/competition-service";
import { moveRegisteredTeamInvitationsToClose } from "@/server/teams/registered-team";
import { hashToken } from "@/server/teams/team-core";
import { formatWib } from "@/lib/dates/date-format";

beforeAll(() => {
  dbState.testRunStarted = true;
});

beforeEach(() => {
  dbState.transaction = null;
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
  noticeSpies.sendTeamCloseNoticeEmail.mockReset();
  noticeSpies.sendTeamCloseNoticeEmail.mockResolvedValue(undefined);
});

let seq = 0;
// Lowercase letters and digits only, so a username built from it passes the invite resolver's
// username pattern.
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type SeededUser = { id: string; email: string; username: string };

const seedCandidate = async (tx: Tx, label: string): Promise<SeededUser> => {
  const username = `closecheck_${label}_${uniqueSuffix()}`;
  const email = `${username}@example.test`;
  const [row] = await tx
    .insert(users)
    .values({ email, username, emailVerified: new Date(), candidateVerifiedAt: new Date() })
    .returning({ id: users.id });
  return { id: row!.id, email, username };
};

const seedOwner = async (tx: Tx): Promise<SeededUser> => {
  const username = `closecheck_owner_${uniqueSuffix()}`;
  const email = `${username}@example.test`;
  const [row] = await tx
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
  return { id: row!.id, email, username };
};

type SeededCompetition = {
  ownerId: string;
  institutionId: string;
  institutionSlug: string;
  competitionId: string;
  competitionSlug: string;
  competitionTitle: string;
  registrationEndAt: Date;
};

type CompetitionSeed = {
  minTeamSize: number;
  maxTeamSize: number;
  registrationEndAt: Date;
  paid?: boolean;
  status?: "published" | "archived";
  deletedAt?: Date;
  allowCancellation?: boolean;
  participation?: {
    participantConfirmationAt: Date;
    participationConfirmedAt?: Date;
    cancelledAt?: Date;
  };
};

const seedCompetition = async (tx: Tx, input: CompetitionSeed): Promise<SeededCompetition> => {
  const id = uniqueSuffix();
  const owner = await seedOwner(tx);
  const institutionSlug = `closecheck-inst-${id}`;
  const competitionSlug = `closecheck-comp-${id}`;
  const competitionTitle = `Lomba Tutup ${id}`;

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: institutionSlug,
      institutionType: "company",
      displayName: `Close Check ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: owner.id,
    membershipRole: "institution_owner",
    status: "active",
  });

  const participation = input.participation;
  const participationColumns = participation
    ? {
        minimumParticipantEntries: 1,
        participantConfirmationAt: participation.participantConfirmationAt,
        ...(participation.participationConfirmedAt
          ? { participationConfirmedAt: participation.participationConfirmedAt }
          : {}),
        ...(participation.cancelledAt
          ? {
              cancelledAt: participation.cancelledAt,
              cancellationReason: "insufficient_participants",
            }
          : {}),
      }
    : {};

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: competitionSlug,
      title: competitionTitle,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "team",
      minTeamSize: input.minTeamSize,
      maxTeamSize: input.maxTeamSize,
      status: input.status ?? "published",
      ...(input.deletedAt ? { deletedAt: input.deletedAt } : {}),
      ...(input.allowCancellation ? { allowCancellation: true, cancellationCutoffDays: 1 } : {}),
      publishedAt: new Date(),
      registrationStartAt: new Date(Date.now() - 7 * DAY_MS),
      registrationEndAt: input.registrationEndAt,
      participantConfirmationAt: new Date(Date.now() + 20 * DAY_MS),
      eventStartAt: new Date(Date.now() + 30 * DAY_MS),
      eventEndAt: new Date(Date.now() + 31 * DAY_MS),
      resultAnnouncementAt: new Date(Date.now() + 40 * DAY_MS),
      feeAmount: input.paid ? 150_000 : null,
      feeCurrency: input.paid ? "IDR" : null,
      ...participationColumns,
    })
    .returning({ id: competitions.id, registrationEndAt: competitions.registrationEndAt });

  return {
    ownerId: owner.id,
    institutionId: institution!.id,
    institutionSlug,
    competitionId: competition!.id,
    competitionSlug,
    competitionTitle,
    registrationEndAt: competition!.registrationEndAt!,
  };
};

// "A registered team" is a submitted team with one confirmed team registration per member.
const seedTeam = async (
  tx: Tx,
  input: {
    competitionId: string;
    captainId: string;
    memberIds: string[];
    status: "forming" | "submitted";
    registeredAt?: Date;
  },
): Promise<string> => {
  const [team] = await tx
    .insert(teams)
    .values({
      competitionId: input.competitionId,
      captainId: input.captainId,
      name: `Tim ${uniqueSuffix()}`,
      status: input.status,
    })
    .returning({ id: teams.id });

  const everyUserId = [input.captainId, ...input.memberIds];
  await tx.insert(teamMemberships).values(
    everyUserId.map((userId) => ({
      teamId: team!.id,
      userId,
      role: userId === input.captainId ? ("captain" as const) : ("member" as const),
      status: "active" as const,
      joinedAt: new Date(),
    })),
  );

  if (input.status === "submitted") {
    const registeredAt = input.registeredAt ?? new Date(Date.now() - 3 * DAY_MS);
    await tx.insert(competitionRegistrations).values(
      everyUserId.map((userId) => ({
        competitionId: input.competitionId,
        studentId: userId,
        teamId: team!.id,
        registrationType: "team" as const,
        status: "confirmed" as const,
        registeredAt,
      })),
    );
  }

  return team!.id;
};

type SeededInvitation = { id: string; tokenHash: string; expiresAt: Date };

const seedInvitation = async (
  tx: Tx,
  input: {
    teamId: string;
    invitedByUserId: string;
    status: "pending" | "pending_claim" | "accepted" | "declined" | "cancelled";
    invitedEmail: string;
    targetUserId?: string | null;
    expiresAt: Date;
    createdAt?: Date;
  },
): Promise<SeededInvitation> => {
  const tokenHash = hashToken(randomUUID());
  const [row] = await tx
    .insert(teamInvitations)
    .values({
      teamId: input.teamId,
      invitedByUserId: input.invitedByUserId,
      invitedEmail: input.invitedEmail,
      targetUserId: input.targetUserId ?? null,
      tokenHash,
      status: input.status,
      expiresAt: input.expiresAt,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: teamInvitations.id, expiresAt: teamInvitations.expiresAt });
  return { id: row!.id, tokenHash, expiresAt: row!.expiresAt };
};

const openInviteToUser = (
  tx: Tx,
  teamId: string,
  captainId: string,
  invitee: SeededUser,
  closesAt: Date,
) =>
  seedInvitation(tx, {
    teamId,
    invitedByUserId: captainId,
    status: "pending",
    invitedEmail: invitee.email,
    targetUserId: invitee.id,
    expiresAt: closesAt,
  });

const teamStatusOf = async (tx: Tx, teamId: string) => {
  const [row] = await tx.select({ status: teams.status }).from(teams).where(eq(teams.id, teamId));
  return row!.status;
};

const invitationOf = async (tx: Tx, invitationId: string) => {
  const [row] = await tx
    .select({
      status: teamInvitations.status,
      expiresAt: teamInvitations.expiresAt,
      targetUserId: teamInvitations.targetUserId,
    })
    .from(teamInvitations)
    .where(eq(teamInvitations.id, invitationId));
  return row!;
};

const registrationsOf = (tx: Tx, competitionId: string, userIds: string[]) =>
  tx
    .select({
      id: competitionRegistrations.id,
      studentId: competitionRegistrations.studentId,
      status: competitionRegistrations.status,
      registrationType: competitionRegistrations.registrationType,
      teamId: competitionRegistrations.teamId,
      cancellationReason: competitionRegistrations.cancellationReason,
      cancelledAt: competitionRegistrations.cancelledAt,
    })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        inArray(competitionRegistrations.studentId, userIds),
      ),
    );

const activeMemberIds = async (tx: Tx, teamId: string): Promise<string[]> => {
  const rows = await tx
    .select({ userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")));
  return rows.map((row) => row.userId).sort();
};

const notificationsOf = (tx: Tx, userId: string) =>
  tx
    .select({ type: notifications.type, title: notifications.title, body: notifications.body })
    .from(notifications)
    .where(eq(notifications.userId, userId));

const closeOf = async (tx: Tx, competitionId: string): Promise<Date> => {
  const [row] = await tx
    .select({ registrationEndAt: competitions.registrationEndAt })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row!.registrationEndAt!;
};

type SeededInvitee = SeededUser & { invitationId: string };

// Registers through the real registration, three days ago, so each open invite takes the close as
// its expiry exactly as a captain's registration gives it.
const registerThroughRealRegistration = async (
  tx: Tx,
  competition: SeededCompetition,
  inviteeLabels: string[],
): Promise<{ rina: SeededUser; budi: SeededUser; teamId: string; invitees: SeededInvitee[] }> => {
  const rina = await seedCandidate(tx, "rina");
  const budi = await seedCandidate(tx, "budi");
  const teamId = await seedTeam(tx, {
    competitionId: competition.competitionId,
    captainId: rina.id,
    memberIds: [budi.id],
    status: "forming",
  });

  const invitees: SeededInvitee[] = [];
  for (const label of inviteeLabels) {
    const user = await seedCandidate(tx, label);
    const invitation = await seedInvitation(tx, {
      teamId,
      invitedByUserId: rina.id,
      status: "pending",
      invitedEmail: user.email,
      targetUserId: user.id,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
    });
    invitees.push({ ...user, invitationId: invitation.id });
  }

  const registered = await submitTeamRegistration(
    rina.id,
    competition.competitionId,
    teamId,
    tx as unknown as Database,
    new Date(Date.now() - 3 * DAY_MS),
  );
  expect(registered.status).toBe("submitted");

  return { rina, budi, teamId, invitees };
};

const markerOf = async (tx: Tx, teamId: string): Promise<Date | null> => {
  const [row] = await tx
    .select({ joinReminderCloseAt: teams.joinReminderCloseAt })
    .from(teams)
    .where(eq(teams.id, teamId));
  return row!.joinReminderCloseAt;
};

const markerMatchesClose = async (tx: Tx, teamId: string): Promise<boolean | null> => {
  const [row] = await tx.execute<{ same: boolean | null }>(
    sql`select t.join_reminder_close_at = c.registration_end_at as same from teams t join competitions c on c.id = t.competition_id where t.id = ${teamId}`,
  );
  return row?.same ?? null;
};

// The text the marker update returns for a close stored with whole milliseconds, as every close a
// test writes from JavaScript is.
const exactUtcText = (value: Date): string => value.toISOString().replace(/Z$/, "000Z");

// Stands for the hourly check having queued this team's reminder for the current close.
const setMarkerToCurrentClose = async (tx: Tx, teamId: string): Promise<void> => {
  await tx.execute(
    sql`update teams set join_reminder_close_at = c.registration_end_at from competitions c where c.id = teams.competition_id and teams.id = ${teamId}`,
  );
};

const reminderJob = (teamId: string, competitionId: string, markedClose: string) =>
  ({
    id: "job-reminder",
    data: { teamId, competitionId, markedClose },
  }) as unknown as TeamJoinReminderJob;

const closeRegistration = async (tx: Tx, competitionId: string): Promise<void> => {
  await tx.execute(
    sql`update competitions set registration_end_at = now() - interval '1 minute' where id = ${competitionId}`,
  );
};

const callsForTeam = (spy: Mock, teamId: string): Record<string, unknown>[] =>
  spy.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((argument) => argument.teamId === teamId);

const runTeamCloseCheckJob = () =>
  processTeamCloseCheckJob({
    id: "job-close-check",
    data: { scheduledFor: "0 * * * *" },
  } as unknown as TeamCloseCheckJob);

const byRegistrationId = (left: Record<string, unknown>, right: Record<string, unknown>): number =>
  String(left.registrationId).localeCompare(String(right.registrationId));

const closePassed = (): Date => new Date(Date.now() - 60_000);

describe.skipIf(skipWithoutDatabase)("the reminder a day before registration closes", () => {
  it("reminds the captain of a team registered through the real registration once, and a second run sends nothing", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const { teamId } = await registerThroughRealRegistration(tx, competition, ["sari"]);

      await runTeamCloseCheckJob();
      await runTeamCloseCheckJob();

      const closeAfterTheRuns = await closeOf(tx, competition.competitionId);
      expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toEqual([
        {
          teamId,
          competitionId: competition.competitionId,
          closesAt: closeAfterTheRuns,
          markedClose: exactUtcText(closeAfterTheRuns),
        },
      ]);
      expect(await markerMatchesClose(tx, teamId)).toBe(true);
    });
  });

  it("reminds once for a registration close stored with microseconds", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const { teamId } = await registerThroughRealRegistration(tx, competition, ["sari"]);
      await tx.execute(
        sql`update competitions set registration_end_at = date_trunc('milliseconds', now()) + interval '23 hours' + interval '123 microseconds' where id = ${competition.competitionId}`,
      );
      const [stored] = await tx.execute<{ micro: number }>(
        sql`select (extract(microseconds from registration_end_at)::bigint % 1000)::int as micro from competitions where id = ${competition.competitionId}`,
      );
      expect(stored?.micro).toBe(123);

      await runTeamCloseCheckJob();
      await runTeamCloseCheckJob();

      expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toHaveLength(1);
      expect(await markerMatchesClose(tx, teamId)).toBe(true);
    });
  });

  it("reminds the captain of a short team that has no open invite", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });

      await runTeamCloseCheckJob();

      expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toHaveLength(1);
    });
  });

  it("sends no reminder to a team registered within the last 24 hours before the close", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
        registeredAt: new Date(Date.now() - 30 * 60_000),
      });
      await openInviteToUser(tx, teamId, captain.id, sari, competition.registrationEndAt);

      await runTeamCloseCheckJob();

      expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toEqual([]);
      expect(await markerOf(tx, teamId)).toBeNull();
    });
  });

  it("sends no reminder to a full team with no open invite", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id, dewi.id],
        status: "submitted",
      });

      await runTeamCloseCheckJob();

      expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toEqual([]);
      expect(await markerOf(tx, teamId)).toBeNull();
    });
  });

  it("sends no reminder while the close is more than 24 hours away", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 25 * HOUR_MS),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      await openInviteToUser(tx, teamId, captain.id, sari, competition.registrationEndAt);

      await runTeamCloseCheckJob();

      expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toEqual([]);
      expect(await markerOf(tx, teamId)).toBeNull();
    });
  });

  it("sends no reminder once the close has passed", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 4,
        registrationEndAt: closePassed(),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const eko = await seedCandidate(tx, "eko");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id, dewi.id],
        status: "submitted",
      });
      await openInviteToUser(tx, teamId, captain.id, eko, new Date(Date.now() + HOUR_MS));

      await runTeamCloseCheckJob();

      expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toEqual([]);
      expect(await markerOf(tx, teamId)).toBeNull();
    });
  });

  it("reminds again once when the host moves the close", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        captain.id,
        sari,
        competition.registrationEndAt,
      );

      await runTeamCloseCheckJob();
      await tx.execute(
        sql`update competitions set registration_end_at = registration_end_at - interval '2 hours' where id = ${competition.competitionId}`,
      );
      const movedClose = await closeOf(tx, competition.competitionId);
      await moveRegisteredTeamInvitationsToClose(
        tx,
        competition.competitionId,
        movedClose,
        new Date(),
      );
      await runTeamCloseCheckJob();
      await runTeamCloseCheckJob();

      expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toEqual([
        {
          teamId,
          competitionId: competition.competitionId,
          closesAt: competition.registrationEndAt,
          markedClose: exactUtcText(competition.registrationEndAt),
        },
        {
          teamId,
          competitionId: competition.competitionId,
          closesAt: movedClose,
          markedClose: exactUtcText(movedClose),
        },
      ]);
      expect((await invitationOf(tx, sariInvite.id)).expiresAt).toEqual(movedClose);
      expect(await markerMatchesClose(tx, teamId)).toBe(true);
    });
  });

  it("sends no reminder to a team of a paid competition", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
        paid: true,
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      await openInviteToUser(tx, teamId, captain.id, sari, competition.registrationEndAt);

      await runTeamCloseCheckJob();

      expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toEqual([]);
      expect(await markerOf(tx, teamId)).toBeNull();
    });
  });
});

// Each test calls the marker update directly for a team the reminder's read chose, whose
// competition or team changed before the update. The archived, cancelled, deleted and forming
// states with a registered team's rows are reached by hand, because the real paths leave no
// registered team there.
describe.skipIf(skipWithoutDatabase)("the reminder marker decides in its own statement", () => {
  const seedRegisteredTeamBeforeClose = async (
    tx: Tx,
    competitionOverrides: Partial<CompetitionSeed>,
    registeredAt?: Date,
  ) => {
    const competition = await seedCompetition(tx, {
      minTeamSize: 3,
      maxTeamSize: 3,
      registrationEndAt: new Date(Date.now() + 20 * HOUR_MS),
      ...competitionOverrides,
    });
    const captain = await seedCandidate(tx, "captain");
    const budi = await seedCandidate(tx, "budi");
    const teamId = await seedTeam(tx, {
      competitionId: competition.competitionId,
      captainId: captain.id,
      memberIds: [budi.id],
      status: "submitted",
      registeredAt,
    });
    return { competition, teamId };
  };

  it("marks a registered team of a published competition with the close it serves", async () => {
    await inRollback(async (tx) => {
      const { competition, teamId } = await seedRegisteredTeamBeforeClose(tx, {});
      const close = await closeOf(tx, competition.competitionId);

      const now = new Date();
      const windowEnd = new Date(now.getTime() + 24 * HOUR_MS);
      const marked = await markJoinReminderForCurrentClose(
        [teamId],
        now,
        windowEnd,
        tx as unknown as Database,
      );

      expect({ marked, marker: await markerOf(tx, teamId) }).toEqual({
        marked: [
          {
            teamId,
            competitionId: competition.competitionId,
            closesAt: close,
            markedClose: exactUtcText(close),
          },
        ],
        marker: close,
      });
      expect(await markerMatchesClose(tx, teamId)).toBe(true);
    });
  });

  it("does not mark a team registered within the last 24 hours before the close", async () => {
    await inRollback(async (tx) => {
      const { teamId } = await seedRegisteredTeamBeforeClose(
        tx,
        {},
        new Date(Date.now() - 30 * 60_000),
      );

      const now = new Date();
      const windowEnd = new Date(now.getTime() + 24 * HOUR_MS);
      const marked = await markJoinReminderForCurrentClose(
        [teamId],
        now,
        windowEnd,
        tx as unknown as Database,
      );

      expect({ marked, marker: await markerOf(tx, teamId) }).toEqual({ marked: [], marker: null });
    });
  });

  it("does not mark a team that is not registered", async () => {
    await inRollback(async (tx) => {
      const { teamId } = await seedRegisteredTeamBeforeClose(tx, {});
      await tx.update(teams).set({ status: "forming" }).where(eq(teams.id, teamId));

      const now = new Date();
      const windowEnd = new Date(now.getTime() + 24 * HOUR_MS);
      const marked = await markJoinReminderForCurrentClose(
        [teamId],
        now,
        windowEnd,
        tx as unknown as Database,
      );

      expect({ marked, marker: await markerOf(tx, teamId) }).toEqual({ marked: [], marker: null });
    });
  });

  it("does not mark a team of a competition that is no longer published", async () => {
    await inRollback(async (tx) => {
      const { teamId } = await seedRegisteredTeamBeforeClose(tx, { status: "archived" });

      const now = new Date();
      const windowEnd = new Date(now.getTime() + 24 * HOUR_MS);
      const marked = await markJoinReminderForCurrentClose(
        [teamId],
        now,
        windowEnd,
        tx as unknown as Database,
      );

      expect({ marked, marker: await markerOf(tx, teamId) }).toEqual({ marked: [], marker: null });
    });
  });

  it("does not mark a team of a cancelled competition", async () => {
    await inRollback(async (tx) => {
      const { teamId } = await seedRegisteredTeamBeforeClose(tx, {
        participation: {
          participantConfirmationAt: new Date(Date.now() + 21 * HOUR_MS),
          cancelledAt: new Date(Date.now() + 22 * HOUR_MS),
        },
      });

      const now = new Date();
      const windowEnd = new Date(now.getTime() + 24 * HOUR_MS);
      const marked = await markJoinReminderForCurrentClose(
        [teamId],
        now,
        windowEnd,
        tx as unknown as Database,
      );

      expect({ marked, marker: await markerOf(tx, teamId) }).toEqual({ marked: [], marker: null });
    });
  });

  it("does not mark a team of a deleted competition", async () => {
    await inRollback(async (tx) => {
      const { teamId } = await seedRegisteredTeamBeforeClose(tx, {
        deletedAt: new Date(Date.now() - 60_000),
      });

      const now = new Date();
      const windowEnd = new Date(now.getTime() + 24 * HOUR_MS);
      const marked = await markJoinReminderForCurrentClose(
        [teamId],
        now,
        windowEnd,
        tx as unknown as Database,
      );

      expect({ marked, marker: await markerOf(tx, teamId) }).toEqual({ marked: [], marker: null });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("what happens at the registration close", () => {
  it("cancels a free team registered through the real registration that is still short at the close, and tells each member once", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const { rina, budi, teamId, invitees } = await registerThroughRealRegistration(
        tx,
        competition,
        ["sari"],
      );
      const sari = invitees[0]!;
      await closeRegistration(tx, competition.competitionId);

      await runTeamCloseCheckJob();
      await runTeamCloseCheckJob();

      expect(await teamStatusOf(tx, teamId)).toBe("forming");
      expect(await activeMemberIds(tx, teamId)).toEqual([rina.id, budi.id].sort());
      const registrations = await registrationsOf(tx, competition.competitionId, [
        rina.id,
        budi.id,
      ]);
      expect(registrations).toHaveLength(2);
      for (const registration of registrations) {
        expect(registration.status).toBe("cancelled");
        expect(registration.cancellationReason).toBe(TEAM_BELOW_MINIMUM_CANCELLATION_REASON);
        expect(registration.cancelledAt).not.toBeNull();
      }
      expect((await invitationOf(tx, sari.invitationId)).status).toBe("cancelled");

      const expectedNotices = registrations.map((registration) => ({
        registrationId: registration.id,
        studentId: registration.studentId,
        competitionId: competition.competitionId,
        teamId,
        memberCount: 2,
        minTeamSize: 3,
      }));
      const noticeCalls = callsForTeam(enqueueSpies.enqueueTeamCancelledBelowMinimum, teamId);
      expect([...noticeCalls].sort(byRegistrationId)).toEqual(
        [...expectedNotices].sort(byRegistrationId),
      );

      const registrationIds = registrations.map((registration) => registration.id);
      const usualCancelledNotices = enqueueSpies.enqueueRegistrationCancelled.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((argument) => registrationIds.includes(String(argument.registrationId)));
      expect(usualCancelledNotices).toEqual([]);

      expect(await notificationsOf(tx, sari.id)).toEqual([]);
      const everyRecordedCall = JSON.stringify(
        [...Object.values(enqueueSpies), noticeSpies.sendTeamCloseNoticeEmail].map(
          (spy) => spy.mock.calls,
        ),
      );
      expect(everyRecordedCall).not.toContain(sari.id);
      expect(everyRecordedCall).not.toContain(sari.invitationId);
    });
  });

  it("cancels the registration of a teammate who joined after the team registered, and tells each remaining member once", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 4,
        maxTeamSize: 4,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const { rina, budi, teamId, invitees } = await registerThroughRealRegistration(
        tx,
        competition,
        ["sari", "dewi"],
      );
      const sari = invitees[0]!;
      const dewi = invitees[1]!;
      const accepted = await acceptTeamInvitationForUser(
        sari.invitationId,
        sari.id,
        tx as unknown as Database,
      );
      expect(accepted).toEqual({ teamId });
      await closeRegistration(tx, competition.competitionId);

      await runTeamCloseCheckJob();

      expect(await teamStatusOf(tx, teamId)).toBe("forming");
      expect(await activeMemberIds(tx, teamId)).toEqual([rina.id, budi.id, sari.id].sort());
      const registrations = await registrationsOf(tx, competition.competitionId, [
        rina.id,
        budi.id,
        sari.id,
      ]);
      expect(registrations).toHaveLength(3);
      for (const registration of registrations) {
        expect(registration.status).toBe("cancelled");
        expect(registration.cancellationReason).toBe(TEAM_BELOW_MINIMUM_CANCELLATION_REASON);
      }
      expect((await invitationOf(tx, sari.invitationId)).status).toBe("accepted");
      expect((await invitationOf(tx, dewi.invitationId)).status).toBe("cancelled");

      const expectedNotices = registrations.map((registration) => ({
        registrationId: registration.id,
        studentId: registration.studentId,
        competitionId: competition.competitionId,
        teamId,
        memberCount: 3,
        minTeamSize: 4,
      }));
      const noticeCalls = callsForTeam(enqueueSpies.enqueueTeamCancelledBelowMinimum, teamId);
      expect([...noticeCalls].sort(byRegistrationId)).toEqual(
        [...expectedNotices].sort(byRegistrationId),
      );
    });
  });

  it("cancels a team that a decline left short, with no unanswered invite at the close, and tells each member once", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const { rina, budi, teamId, invitees } = await registerThroughRealRegistration(
        tx,
        competition,
        ["sari"],
      );
      const sari = invitees[0]!;

      await expect(
        declineTeamInvitationForUser(sari.invitationId, sari.id, tx as unknown as Database),
      ).resolves.toBeUndefined();

      expect((await invitationOf(tx, sari.invitationId)).status).toBe("declined");
      const unansweredInvitations = await tx
        .select({ id: teamInvitations.id })
        .from(teamInvitations)
        .where(
          and(
            eq(teamInvitations.teamId, teamId),
            inArray(teamInvitations.status, ["pending", "pending_claim"]),
          ),
        );
      expect(unansweredInvitations).toHaveLength(0);

      await closeRegistration(tx, competition.competitionId);

      await runTeamCloseCheckJob();

      expect(await teamStatusOf(tx, teamId)).toBe("forming");
      expect(await activeMemberIds(tx, teamId)).toEqual([rina.id, budi.id].sort());
      const registrations = await registrationsOf(tx, competition.competitionId, [
        rina.id,
        budi.id,
      ]);
      expect(registrations).toHaveLength(2);
      for (const registration of registrations) {
        expect(registration.status).toBe("cancelled");
        expect(registration.cancellationReason).toBe(TEAM_BELOW_MINIMUM_CANCELLATION_REASON);
        expect(registration.cancelledAt).not.toBeNull();
      }
      expect((await invitationOf(tx, sari.invitationId)).status).toBe("declined");

      const expectedNotices = registrations.map((registration) => ({
        registrationId: registration.id,
        studentId: registration.studentId,
        competitionId: competition.competitionId,
        teamId,
        memberCount: 2,
        minTeamSize: 3,
      }));
      const noticeCalls = callsForTeam(enqueueSpies.enqueueTeamCancelledBelowMinimum, teamId);
      expect([...noticeCalls].sort(byRegistrationId)).toEqual(
        [...expectedNotices].sort(byRegistrationId),
      );
    });
  });

  it("keeps a team at the minimum registered and closes its open invite", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 4,
        registrationEndAt: closePassed(),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const eko = await seedCandidate(tx, "eko");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id, dewi.id],
        status: "submitted",
      });
      const ekoInvite = await openInviteToUser(
        tx,
        teamId,
        captain.id,
        eko,
        competition.registrationEndAt,
      );

      await runTeamCloseCheckJob();

      expect(await teamStatusOf(tx, teamId)).toBe("submitted");
      const registrations = await registrationsOf(tx, competition.competitionId, [
        captain.id,
        budi.id,
        dewi.id,
      ]);
      expect(registrations.map((registration) => registration.status)).toEqual([
        "confirmed",
        "confirmed",
        "confirmed",
      ]);
      expect((await invitationOf(tx, ekoInvite.id)).status).toBe("cancelled");
      expect(callsForTeam(enqueueSpies.enqueueTeamCancelledBelowMinimum, teamId)).toEqual([]);
    });
  });

  it("leaves a paid team competition untouched at the close", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: closePassed(),
        paid: true,
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        captain.id,
        sari,
        new Date(Date.now() + 7 * DAY_MS),
      );

      await runTeamCloseCheckJob();
      const settled = await settleTeamsAtRegistrationClose(
        competition.competitionId,
        new Date(),
        tx as unknown as Database,
      );

      expect(settled).toEqual({
        competitionId: competition.competitionId,
        closedInvitationCount: 0,
        cancelledTeams: [],
      });
      expect(await teamStatusOf(tx, teamId)).toBe("submitted");
      const registrations = await registrationsOf(tx, competition.competitionId, [
        captain.id,
        budi.id,
      ]);
      expect(registrations.map((registration) => registration.status)).toEqual([
        "confirmed",
        "confirmed",
      ]);
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("pending");
    });
  });

  it("cancels no team once the organiser confirmed participation, and still closes its open invite", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() - 2 * HOUR_MS),
        participation: {
          participantConfirmationAt: new Date(Date.now() - 30 * 60_000),
          participationConfirmedAt: new Date(Date.now() - 60_000),
        },
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        captain.id,
        sari,
        competition.registrationEndAt,
      );

      // A now after the close and before the participant confirmation moment, so the freeze is
      // open and only the organiser's confirmation declines.
      const settled = await settleTeamsAtRegistrationClose(
        competition.competitionId,
        new Date(Date.now() - HOUR_MS),
        tx as unknown as Database,
      );

      expect(settled).toEqual({
        competitionId: competition.competitionId,
        closedInvitationCount: 1,
        cancelledTeams: [],
      });
      expect(await teamStatusOf(tx, teamId)).toBe("submitted");
      const registrations = await registrationsOf(tx, competition.competitionId, [
        captain.id,
        budi.id,
      ]);
      expect(registrations.map((registration) => registration.status)).toEqual([
        "confirmed",
        "confirmed",
      ]);
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("cancelled");
      expect(callsForTeam(enqueueSpies.enqueueTeamCancelledBelowMinimum, teamId)).toEqual([]);
    });
  });

  it("cancels no team once the participant confirmation moment has passed, and still closes its open invite", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() - HOUR_MS),
        participation: { participantConfirmationAt: new Date(Date.now() - 30 * 60_000) },
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        captain.id,
        sari,
        competition.registrationEndAt,
      );

      await runTeamCloseCheckJob();

      expect(await teamStatusOf(tx, teamId)).toBe("submitted");
      const registrations = await registrationsOf(tx, competition.competitionId, [
        captain.id,
        budi.id,
      ]);
      expect(registrations.map((registration) => registration.status)).toEqual([
        "confirmed",
        "confirmed",
      ]);
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("cancelled");
      expect(callsForTeam(enqueueSpies.enqueueTeamCancelledBelowMinimum, teamId)).toEqual([]);
    });
  });

  it("cancels no team of a cancelled competition", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() - 2 * HOUR_MS),
        participation: {
          participantConfirmationAt: new Date(Date.now() - 30 * 60_000),
          cancelledAt: new Date(Date.now() - 60_000),
        },
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      // The real cancellation for insufficient participation cancels every registration of the
      // competition, so a registered team of a cancelled competition is reached by hand here.
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        captain.id,
        sari,
        competition.registrationEndAt,
      );

      // A now after the close and before the participant confirmation moment, so the freeze is
      // open and only the competition's cancellation declines.
      const settled = await settleTeamsAtRegistrationClose(
        competition.competitionId,
        new Date(Date.now() - HOUR_MS),
        tx as unknown as Database,
      );

      expect(settled).toEqual({
        competitionId: competition.competitionId,
        closedInvitationCount: 1,
        cancelledTeams: [],
      });
      expect(await teamStatusOf(tx, teamId)).toBe("submitted");
      const registrations = await registrationsOf(tx, competition.competitionId, [
        captain.id,
        budi.id,
      ]);
      expect(registrations.map((registration) => registration.status)).toEqual([
        "confirmed",
        "confirmed",
      ]);
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("cancelled");
      expect(callsForTeam(enqueueSpies.enqueueTeamCancelledBelowMinimum, teamId)).toEqual([]);
    });
  });

  it("does nothing when called for a competition whose close is still ahead", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + HOUR_MS),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        captain.id,
        sari,
        competition.registrationEndAt,
      );

      const settled = await settleTeamsAtRegistrationClose(
        competition.competitionId,
        new Date(),
        tx as unknown as Database,
      );

      expect(settled).toEqual({
        competitionId: competition.competitionId,
        closedInvitationCount: 0,
        cancelledTeams: [],
      });
      expect(await teamStatusOf(tx, teamId)).toBe("submitted");
      const registrations = await registrationsOf(tx, competition.competitionId, [
        captain.id,
        budi.id,
      ]);
      expect(registrations.map((registration) => registration.status)).toEqual([
        "confirmed",
        "confirmed",
      ]);
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("pending");
    });
  });

  it("leaves the invites of a forming team open at the close", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 4,
        registrationEndAt: closePassed(),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const eko = await seedCandidate(tx, "eko");
      const fajar = await seedCandidate(tx, "fajar");
      const gita = await seedCandidate(tx, "gita");
      const registeredTeamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id, dewi.id],
        status: "submitted",
      });
      const ekoInvite = await openInviteToUser(
        tx,
        registeredTeamId,
        captain.id,
        eko,
        competition.registrationEndAt,
      );
      const formingTeamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: fajar.id,
        memberIds: [],
        status: "forming",
      });
      const gitaInvite = await openInviteToUser(
        tx,
        formingTeamId,
        fajar.id,
        gita,
        new Date(Date.now() + 7 * DAY_MS),
      );

      await runTeamCloseCheckJob();

      expect((await invitationOf(tx, ekoInvite.id)).status).toBe("cancelled");
      expect((await invitationOf(tx, gitaInvite.id)).status).toBe("pending");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the captain's reminder and the members' notice", () => {
  const queueReminderThroughTheRealCheck = async (tx: Tx, allowCancellation?: boolean) => {
    const competition = await seedCompetition(tx, {
      minTeamSize: 3,
      maxTeamSize: 3,
      registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      allowCancellation,
    });
    const { rina, teamId } = await registerThroughRealRegistration(tx, competition, ["sari"]);

    await runTeamCloseCheckJob();

    expect(callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)).toHaveLength(1);
    return {
      competition,
      rina,
      teamId,
      markedClose: String(
        callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)[0]?.markedClose,
      ),
    };
  };

  it("tells the captain who has not joined, how many the team needs and when registration closes", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 4,
        maxTeamSize: 4,
        registrationEndAt: new Date(Date.now() + 20 * HOUR_MS),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const suffix = uniqueSuffix();
      const dewiEmail = `dewi_${suffix}@example.test`;
      const ekoEmail = `eko_${suffix}@example.test`;
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      await seedInvitation(tx, {
        teamId,
        invitedByUserId: captain.id,
        status: "pending",
        invitedEmail: sari.email,
        targetUserId: sari.id,
        expiresAt: competition.registrationEndAt,
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
      });
      await seedInvitation(tx, {
        teamId,
        invitedByUserId: captain.id,
        status: "pending_claim",
        invitedEmail: dewiEmail,
        targetUserId: null,
        expiresAt: competition.registrationEndAt,
        createdAt: new Date(Date.now() - HOUR_MS),
      });
      await seedInvitation(tx, {
        teamId,
        invitedByUserId: captain.id,
        status: "pending_claim",
        invitedEmail: ekoEmail,
        targetUserId: null,
        expiresAt: new Date(Date.now() - HOUR_MS),
        createdAt: new Date(Date.now() - 3 * HOUR_MS),
      });

      await setMarkerToCurrentClose(tx, teamId);

      await processTeamJoinReminderJob(
        reminderJob(teamId, competition.competitionId, exactUtcText(competition.registrationEndAt)),
      );

      const title = `Pendaftaran ${competition.competitionTitle} ditutup dalam 24 jam`;
      const closeAsRead = await closeOf(tx, competition.competitionId);
      const body = [
        `Pendaftaran ditutup pada ${formatWib(closeAsRead, "longDateTime")} WIB.`,
        `Undangan untuk ${sari.email}, ${dewiEmail} belum diterima.`,
        "Tim Anda masih membutuhkan 2 anggota lagi untuk mencapai jumlah minimal 4 anggota.",
        "Jika sampai saat itu jumlah anggota masih kurang, pendaftaran tim dibatalkan secara otomatis.",
        "Anda masih dapat membatalkan undangan dan mengundang orang lain sebelum pendaftaran ditutup.",
      ].join(" ");
      expect(await notificationsOf(tx, captain.id)).toEqual([
        { type: "team_join_reminder", title, body },
      ]);
      expect(noticeSpies.sendTeamCloseNoticeEmail).toHaveBeenCalledTimes(1);
      expect(noticeSpies.sendTeamCloseNoticeEmail).toHaveBeenCalledWith({
        kind: "team_join_reminder",
        toEmail: captain.email,
        recipientId: captain.id,
        notice: { title, body },
        teamPagePath: `/competitions/${competition.institutionSlug}/${competition.competitionSlug}/registration`,
      });
      expect(await notificationsOf(tx, budi.id)).toEqual([]);
      expect(await notificationsOf(tx, sari.id)).toEqual([]);
    });
  });

  it("skips the reminder when no teammate is missing any more", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 20 * HOUR_MS),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id, dewi.id],
        status: "submitted",
      });

      await setMarkerToCurrentClose(tx, teamId);

      await expect(
        processTeamJoinReminderJob(
          reminderJob(
            teamId,
            competition.competitionId,
            exactUtcText(competition.registrationEndAt),
          ),
        ),
      ).resolves.toBeUndefined();

      expect(await notificationsOf(tx, captain.id)).toEqual([]);
      expect(noticeSpies.sendTeamCloseNoticeEmail).not.toHaveBeenCalled();
    });
  });

  it("sends nothing when the host unpublished the competition after the reminder was queued", async () => {
    await inRollback(async (tx) => {
      const { competition, rina, teamId, markedClose } = await queueReminderThroughTheRealCheck(tx);

      await unpublishCompetition(
        competition.ownerId,
        competition.competitionId,
        tx as unknown as Database,
      );

      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, markedClose)),
      ).resolves.toBeUndefined();

      expect({
        inbox: await notificationsOf(tx, rina.id),
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
      }).toEqual({ inbox: [], sends: 0 });
      expect(await teamStatusOf(tx, teamId)).toBe("cancelled");
    });
  });

  it("sends nothing to a registered team whose competition is a draft", async () => {
    await inRollback(async (tx) => {
      const { competition, rina, teamId, markedClose } = await queueReminderThroughTheRealCheck(tx);
      await tx
        .update(competitions)
        .set({ status: "draft" })
        .where(eq(competitions.id, competition.competitionId));

      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, markedClose)),
      ).resolves.toBeUndefined();

      expect({
        inbox: await notificationsOf(tx, rina.id),
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
        team: await teamStatusOf(tx, teamId),
      }).toEqual({ inbox: [], sends: 0, team: "submitted" });
    });
  });

  it("sends nothing when registration closed before the reminder was delivered", async () => {
    await inRollback(async (tx) => {
      const { competition, rina, teamId } = await queueReminderThroughTheRealCheck(tx);

      const passedClose = closePassed();
      await tx
        .update(competitions)
        .set({ registrationEndAt: passedClose })
        .where(eq(competitions.id, competition.competitionId));
      await setMarkerToCurrentClose(tx, teamId);

      await expect(
        processTeamJoinReminderJob(
          reminderJob(teamId, competition.competitionId, exactUtcText(passedClose)),
        ),
      ).resolves.toBeUndefined();

      expect({
        inbox: await notificationsOf(tx, rina.id),
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
      }).toEqual({ inbox: [], sends: 0 });
    });
  });

  it("sends nothing to a captain who cancelled the team's registration after the reminder was queued", async () => {
    await inRollback(async (tx) => {
      const { competition, rina, teamId, markedClose } = await queueReminderThroughTheRealCheck(
        tx,
        true,
      );

      await expect(
        cancelTeamRegistration(
          rina.id,
          competition.competitionId,
          teamId,
          "Kami batal ikut",
          tx as unknown as Database,
        ),
      ).resolves.toMatchObject({ status: "forming" });

      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, markedClose)),
      ).resolves.toBeUndefined();

      expect({
        inbox: await notificationsOf(tx, rina.id),
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
      }).toEqual({ inbox: [], sends: 0 });
    });
  });

  it("sends nothing when the close moved later after the reminder was queued, and reminds once for the new close when it is due", async () => {
    await inRollback(async (tx) => {
      const { competition, rina, teamId, markedClose } = await queueReminderThroughTheRealCheck(tx);

      await tx.execute(
        sql`update competitions set registration_end_at = registration_end_at + interval '4 days' where id = ${competition.competitionId}`,
      );
      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, markedClose)),
      ).resolves.toBeUndefined();
      await runTeamCloseCheckJob();
      await tx.execute(
        sql`update competitions set registration_end_at = now() + interval '20 hours' where id = ${competition.competitionId}`,
      );
      await runTeamCloseCheckJob();
      const dueClose = await closeOf(tx, competition.competitionId);

      expect({
        inbox: await notificationsOf(tx, rina.id),
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
        reminders: callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId).map(
          (call) => call.closesAt,
        ),
      }).toEqual({
        inbox: [],
        sends: 0,
        reminders: [competition.registrationEndAt, dueClose],
      });
    });
  });

  it("sends nothing when the close moved earlier after the reminder was queued, and the next run does not remind a team registered within 24 hours of the new close", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
        registeredAt: new Date(Date.now() - 12 * HOUR_MS),
      });
      await openInviteToUser(tx, teamId, rina.id, sari, competition.registrationEndAt);

      await runTeamCloseCheckJob();
      const markedClose = String(
        callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)[0]?.markedClose,
      );
      await tx.execute(
        sql`update competitions set registration_end_at = now() + interval '2 hours' where id = ${competition.competitionId}`,
      );
      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, markedClose)),
      ).resolves.toBeUndefined();
      await runTeamCloseCheckJob();

      expect({
        inbox: await notificationsOf(tx, rina.id),
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
        reminders: callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId).length,
        marker: await markerOf(tx, teamId),
      }).toEqual({ inbox: [], sends: 0, reminders: 1, marker: competition.registrationEndAt });
    });
  });

  it("sends nothing when the team's marker names another close than the queued one", async () => {
    await inRollback(async (tx) => {
      const { competition, rina, teamId, markedClose } = await queueReminderThroughTheRealCheck(tx);

      await tx.execute(
        sql`update teams set join_reminder_close_at = join_reminder_close_at + interval '1 hour' where id = ${teamId}`,
      );
      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, markedClose)),
      ).resolves.toBeUndefined();

      expect({
        inbox: await notificationsOf(tx, rina.id),
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
      }).toEqual({ inbox: [], sends: 0 });
    });
  });

  it("sends nothing when the close the marker names is more than 24 hours away", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 5 * DAY_MS),
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      await openInviteToUser(tx, teamId, rina.id, sari, competition.registrationEndAt);

      await setMarkerToCurrentClose(tx, teamId);
      await expect(
        processTeamJoinReminderJob(
          reminderJob(
            teamId,
            competition.competitionId,
            exactUtcText(competition.registrationEndAt),
          ),
        ),
      ).resolves.toBeUndefined();

      expect({
        inbox: await notificationsOf(tx, rina.id),
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
        matches: await markerMatchesClose(tx, teamId),
      }).toEqual({ inbox: [], sends: 0, matches: true });
    });
  });

  it("sends nothing from a reminder queued for a close that has since been moved and marked again, and the new close's reminder is sent once", async () => {
    await inRollback(async (tx) => {
      const { competition, rina, teamId, markedClose } = await queueReminderThroughTheRealCheck(tx);

      await tx.execute(
        sql`update competitions set registration_end_at = now() + interval '20 hours' where id = ${competition.competitionId}`,
      );
      await runTeamCloseCheckJob();
      const newMarkedClose = String(
        callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)[1]?.markedClose,
      );
      const dueClose = await closeOf(tx, competition.competitionId);

      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, markedClose)),
      ).resolves.toBeUndefined();
      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, newMarkedClose)),
      ).resolves.toBeUndefined();

      expect({
        inbox: (await notificationsOf(tx, rina.id)).length,
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
        reminders: callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId).length,
        sentBodiesNameTheNewClose: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.map((call) =>
          (call[0] as { notice: { body: string } }).notice.body.includes(
            formatWib(dueClose, "longDateTime"),
          ),
        ),
      }).toEqual({ inbox: 1, sends: 1, reminders: 2, sentBodiesNameTheNewClose: [true] });
    });
  });

  it("delivers the reminder for a close stored with microseconds", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const { rina, teamId } = await registerThroughRealRegistration(tx, competition, ["sari"]);
      await tx.execute(
        sql`update competitions set registration_end_at = date_trunc('milliseconds', now()) + interval '23 hours' + interval '123 microseconds' where id = ${competition.competitionId}`,
      );

      await runTeamCloseCheckJob();
      const markedClose = String(
        callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)[0]?.markedClose,
      );
      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, markedClose)),
      ).resolves.toBeUndefined();

      expect({
        inbox: (await notificationsOf(tx, rina.id)).length,
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
        markedCloseKeepsMicroseconds: /\.\d{3}123Z$/.test(markedClose),
      }).toEqual({ inbox: 1, sends: 1, markedCloseKeepsMicroseconds: true });
    });
  });

  it("delivers the reminder when the database session is not in UTC", async () => {
    await inRollback(async (tx) => {
      // A session outside UTC must not change the close the reminder carries.
      await tx.execute(sql`set local time zone 'Asia/Jakarta'`);
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() + 23 * HOUR_MS),
      });
      const { rina, teamId } = await registerThroughRealRegistration(tx, competition, ["sari"]);
      await tx.execute(
        sql`update competitions set registration_end_at = date_trunc('milliseconds', now()) + interval '23 hours' where id = ${competition.competitionId}`,
      );

      await runTeamCloseCheckJob();
      const markedClose = String(
        callsForTeam(enqueueSpies.enqueueTeamJoinReminder, teamId)[0]?.markedClose,
      );
      await expect(
        processTeamJoinReminderJob(reminderJob(teamId, competition.competitionId, markedClose)),
      ).resolves.toBeUndefined();
      const closeAsRead = await closeOf(tx, competition.competitionId);

      expect({
        inbox: (await notificationsOf(tx, rina.id)).length,
        sends: noticeSpies.sendTeamCloseNoticeEmail.mock.calls.length,
        markedCloseIsUtc: markedClose === exactUtcText(closeAsRead),
      }).toEqual({ inbox: 1, sends: 1, markedCloseIsUtc: true });
    });
  });

  it("tells a remaining member why the team's registration was cancelled", async () => {
    await inRollback(async (tx) => {
      const competition = await seedCompetition(tx, {
        minTeamSize: 3,
        maxTeamSize: 3,
        registrationEndAt: new Date(Date.now() - HOUR_MS),
      });
      const captain = await seedCandidate(tx, "captain");
      const budi = await seedCandidate(tx, "budi");
      const teamId = await seedTeam(tx, {
        competitionId: competition.competitionId,
        captainId: captain.id,
        memberIds: [budi.id],
        status: "forming",
      });
      const [budiRegistration] = await tx
        .insert(competitionRegistrations)
        .values({
          competitionId: competition.competitionId,
          studentId: budi.id,
          teamId,
          registrationType: "team",
          status: "cancelled",
          registeredAt: new Date(Date.now() - 3 * DAY_MS),
          cancelledAt: new Date(),
          cancellationReason: TEAM_BELOW_MINIMUM_CANCELLATION_REASON,
        })
        .returning({ id: competitionRegistrations.id });

      await processTeamCancelledBelowMinimumJob({
        id: "job-notice",
        data: {
          registrationId: budiRegistration!.id,
          studentId: budi.id,
          competitionId: competition.competitionId,
          teamId,
          memberCount: 2,
          minTeamSize: 3,
        },
      } as unknown as TeamCancelledBelowMinimumJob);

      const title = `Pendaftaran tim dibatalkan otomatis untuk ${competition.competitionTitle}`;
      const body = [
        "Saat pendaftaran ditutup, tim Anda baru memiliki 2 anggota, kurang dari jumlah minimal 3 anggota.",
        "Karena itu pendaftaran tim dibatalkan secara otomatis.",
        "Tim Anda tetap ada bersama anggota yang sudah bergabung.",
        "Pembatalan ini tidak dilakukan oleh penyelenggara dan bukan atas permintaan Anda.",
      ].join(" ");
      expect(await notificationsOf(tx, budi.id)).toEqual([
        { type: "team_cancelled_below_minimum", title, body },
      ]);
      expect(noticeSpies.sendTeamCloseNoticeEmail).toHaveBeenCalledTimes(1);
      expect(noticeSpies.sendTeamCloseNoticeEmail).toHaveBeenCalledWith({
        kind: "team_cancelled_below_minimum",
        toEmail: budi.email,
        recipientId: budi.id,
        notice: { title, body },
        teamPagePath: `/competitions/${competition.institutionSlug}/${competition.competitionSlug}/registration`,
      });
    });
  });
});

describe("today's team cancellation's handle", () => {
  it("takes only a transaction handle", () => {
    // A bare database runs the two writes outside one transaction, so it must not be accepted.
    expectTypeOf<Database>().not.toExtend<Parameters<typeof revertSubmittedTeamToForming>[0]>();
  });
});
