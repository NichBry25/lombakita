// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, and, eq, sql } from "drizzle-orm";
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
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  actorUserId: null as string | null,
  testRunStarted: false,
}));

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (routeState.transaction) return routeState.transaction;
      if (!routeState.testRunStarted) return actual.getDb();
      throw new Error("a join route read the database outside a test");
    },
  };
});

vi.mock("@/server/auth/session", () => {
  const stagedSession = () => {
    if (!routeState.actorUserId) {
      throw new Error("a join route ran with no session staged");
    }
    return { user: { id: routeState.actorUserId, role: "candidate" } };
  };
  return {
    requireSessionRole: async () => stagedSession(),
    requireAuthenticatedSession: async () => stagedSession(),
  };
});

const enqueueSpies = vi.hoisted(() => ({
  enqueueTeamInvitationDispatch: vi.fn(),
  enqueueRegistrationConfirmed: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, ...enqueueSpies };
});

import { POST as registerIndividualRoute } from "@/app/api/v1/competitions/[competitionId]/registrations/route";
import { POST as createTeamRoute } from "@/app/api/v1/competitions/[competitionId]/teams/route";
import { POST as registerTeamRoute } from "@/app/api/v1/competitions/[competitionId]/teams/[teamId]/registrations/route";
import { POST as inviteRoute } from "@/app/api/v1/teams/[teamId]/invitations/route";
import { POST as acceptRoute } from "@/app/api/v1/me/invitations/team/[invitationId]/accept/route";
import { hashToken } from "@/server/teams/team-core";

beforeAll(() => {
  routeState.testRunStarted = true;
});

beforeEach(() => {
  routeState.transaction = null;
  routeState.actorUserId = null;
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

let seq = 0;
// Lowercase letters and digits only, so a username built from it passes the invite resolver's
// username pattern.
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

type SeededUser = { id: string; email: string; username: string };

const seedPerson = async (tx: Tx, label: string): Promise<SeededUser> => {
  const username = `host_${label}_${uniqueSuffix()}`;
  const email = `${username}@example.test`;
  const [row] = await tx
    .insert(users)
    .values({ email, username, emailVerified: new Date(), candidateVerifiedAt: new Date() })
    .returning({ id: users.id });
  return { id: row!.id, email, username };
};

type MembershipRole = "institution_owner" | "institution_staff" | "institution_member";

const seedInstitution = async (
  tx: Tx,
  label: string,
  memberships: { userId: string; role: MembershipRole }[],
): Promise<string> => {
  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `host-${label}-${uniqueSuffix()}`,
      institutionType: "company",
      displayName: `Penyelenggara ${label}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionMemberships).values(
    memberships.map((membership) => ({
      institutionId: institution!.id,
      userId: membership.userId,
      membershipRole: membership.role,
      status: "active" as const,
    })),
  );
  return institution!.id;
};

type People = {
  owner: SeededUser;
  staff: SeededUser;
  plainMember: SeededUser;
  otherHost: SeededUser;
  captain: SeededUser;
};

type SeededCompetition = { competitionId: string; registrationEndAt: Date; people: People };

// A free, published competition that takes individuals and teams. Its institution has an owner, a
// staff member and a plain member, and another institution's owner is on the side.
const seedCompetition = async (tx: Tx): Promise<SeededCompetition> => {
  const people: People = {
    owner: await seedPerson(tx, "owner"),
    staff: await seedPerson(tx, "staff"),
    plainMember: await seedPerson(tx, "member"),
    otherHost: await seedPerson(tx, "other"),
    captain: await seedPerson(tx, "captain"),
  };
  const institutionId = await seedInstitution(tx, "main", [
    { userId: people.owner.id, role: "institution_owner" },
    { userId: people.staff.id, role: "institution_staff" },
    { userId: people.plainMember.id, role: "institution_member" },
  ]);
  await seedInstitution(tx, "other", [{ userId: people.otherHost.id, role: "institution_owner" }]);

  const id = uniqueSuffix();
  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId,
      slug: `host-comp-${id}`,
      title: `Kompetisi penyelenggara ${id}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "both",
      minTeamSize: 1,
      maxTeamSize: 5,
      status: "published",
      publishedAt: new Date(),
      registrationStartAt: new Date(Date.now() - 7 * DAY_MS),
      registrationEndAt: new Date(Date.now() + 14 * DAY_MS),
      participantConfirmationAt: new Date(Date.now() + 20 * DAY_MS),
      eventStartAt: new Date(Date.now() + 30 * DAY_MS),
      eventEndAt: new Date(Date.now() + 31 * DAY_MS),
      resultAnnouncementAt: new Date(Date.now() + 40 * DAY_MS),
    })
    .returning({ id: competitions.id, registrationEndAt: competitions.registrationEndAt });

  return {
    competitionId: competition!.id,
    registrationEndAt: competition!.registrationEndAt!,
    people,
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
    await tx.insert(competitionRegistrations).values(
      everyUserId.map((userId) => ({
        competitionId: input.competitionId,
        studentId: userId,
        teamId: team!.id,
        registrationType: "team" as const,
        status: "confirmed" as const,
        registeredAt: new Date(),
      })),
    );
  }

  return team!.id;
};

const seedOpenInvite = async (
  tx: Tx,
  input: { teamId: string; captainId: string; invitee: SeededUser; expiresAt: Date },
): Promise<string> => {
  const [row] = await tx
    .insert(teamInvitations)
    .values({
      teamId: input.teamId,
      invitedByUserId: input.captainId,
      invitedEmail: input.invitee.email,
      targetUserId: input.invitee.id,
      tokenHash: hashToken(randomUUID()),
      status: "pending",
      expiresAt: input.expiresAt,
    })
    .returning({ id: teamInvitations.id });
  return row!.id;
};

type RouteAnswer = { status: number; code: string | undefined };

const stageActor = (tx: Tx, userId: string): void => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = userId;
};

const answerOf = async (response: Response): Promise<RouteAnswer> => {
  const body = (await response.json()) as { error?: { code?: string } };
  return { status: response.status, code: body.error?.code };
};

const registerIndividuallyViaRoute = async (
  tx: Tx,
  userId: string,
  competitionId: string,
): Promise<RouteAnswer> => {
  stageActor(tx, userId);
  const response = await registerIndividualRoute(
    new Request(`https://lombakita.test/api/v1/competitions/${competitionId}/registrations`, {
      method: "POST",
      headers: { "X-Expected-User-Id": userId },
    }),
    { params: Promise.resolve({ competitionId }) },
  );
  return answerOf(response);
};

const createTeamViaRoute = async (
  tx: Tx,
  userId: string,
  competitionId: string,
  name: string,
): Promise<RouteAnswer> => {
  stageActor(tx, userId);
  const response = await createTeamRoute(
    new Request(`https://lombakita.test/api/v1/competitions/${competitionId}/teams`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Expected-User-Id": userId },
      body: JSON.stringify({ name }),
    }),
    { params: Promise.resolve({ competitionId }) },
  );
  return answerOf(response);
};

const inviteViaRoute = async (
  tx: Tx,
  captainId: string,
  teamId: string,
  invitedIdentifier: string,
): Promise<RouteAnswer> => {
  stageActor(tx, captainId);
  const response = await inviteRoute(
    new Request(`https://lombakita.test/api/v1/teams/${teamId}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Expected-User-Id": captainId },
      body: JSON.stringify({ invitedIdentifier }),
    }),
    { params: Promise.resolve({ teamId }) },
  );
  return answerOf(response);
};

const acceptViaRoute = async (
  tx: Tx,
  userId: string,
  invitationId: string,
): Promise<RouteAnswer> => {
  stageActor(tx, userId);
  const response = await acceptRoute(
    new Request(`https://lombakita.test/api/v1/me/invitations/team/${invitationId}/accept`, {
      method: "POST",
      headers: { "X-Expected-User-Id": userId },
    }),
    { params: Promise.resolve({ invitationId }) },
  );
  return answerOf(response);
};

const registerTeamViaRoute = async (
  tx: Tx,
  captainId: string,
  competitionId: string,
  teamId: string,
): Promise<RouteAnswer> => {
  stageActor(tx, captainId);
  const response = await registerTeamRoute(
    new Request(
      `https://lombakita.test/api/v1/competitions/${competitionId}/teams/${teamId}/registrations`,
      { method: "POST", headers: { "X-Expected-User-Id": captainId } },
    ),
    { params: Promise.resolve({ competitionId, teamId }) },
  );
  return answerOf(response);
};

const confirmedRegistrationsOf = async (
  tx: Tx,
  competitionId: string,
  userId: string,
): Promise<number> => {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        eq(competitionRegistrations.studentId, userId),
        eq(competitionRegistrations.status, "confirmed"),
      ),
    );
  return row!.count;
};

const confirmedRegistrationsOfTeam = async (tx: Tx, teamId: string): Promise<number> => {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.teamId, teamId),
        eq(competitionRegistrations.status, "confirmed"),
      ),
    );
  return row!.count;
};

const teamsCaptainedBy = async (tx: Tx, competitionId: string, userId: string): Promise<number> => {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(teams)
    .where(and(eq(teams.competitionId, competitionId), eq(teams.captainId, userId)));
  return row!.count;
};

const invitesTo = async (tx: Tx, teamId: string, email: string): Promise<number> => {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(teamInvitations)
    .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.invitedEmail, email)));
  return row!.count;
};

const activeSeatsOf = async (tx: Tx, teamId: string, userId: string): Promise<number> => {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.userId, userId),
        eq(teamMemberships.status, "active"),
      ),
    );
  return row!.count;
};

const invitationStatusOf = async (tx: Tx, invitationId: string): Promise<string> => {
  const [row] = await tx
    .select({ status: teamInvitations.status })
    .from(teamInvitations)
    .where(eq(teamInvitations.id, invitationId));
  return row!.status;
};

const teamStatusOf = async (tx: Tx, teamId: string): Promise<string> => {
  const [row] = await tx.select({ status: teams.status }).from(teams).where(eq(teams.id, teamId));
  return row!.status;
};

const outcomesFor = async <T>(
  people: People,
  outcomeOf: (person: SeededUser) => Promise<T>,
): Promise<{ owner: T; staff: T; plainMember: T; otherHost: T }> => ({
  owner: await outcomeOf(people.owner),
  staff: await outcomeOf(people.staff),
  plainMember: await outcomeOf(people.plainMember),
  otherHost: await outcomeOf(people.otherHost),
});

describe.skipIf(skipWithoutDatabase)(
  "the owner and staff of a competition's institution cannot join it, through the real routes",
  () => {
    it("refuses the owner and staff an individual registration, and registers a plain member and another institution's owner", async () => {
      await inRollback(async (tx) => {
        const { competitionId, people } = await seedCompetition(tx);

        const seen = await outcomesFor(people, async (person) => ({
          ...(await registerIndividuallyViaRoute(tx, person.id, competitionId)),
          registrations: await confirmedRegistrationsOf(tx, competitionId, person.id),
        }));

        expect(seen).toEqual({
          owner: { status: 403, code: "registration_host_of_competition", registrations: 0 },
          staff: { status: 403, code: "registration_host_of_competition", registrations: 0 },
          plainMember: { status: 201, code: undefined, registrations: 1 },
          otherHost: { status: 201, code: undefined, registrations: 1 },
        });
      });
    });

    it("refuses the owner and staff a new team, and lets a plain member and another institution's owner create one", async () => {
      await inRollback(async (tx) => {
        const { competitionId, people } = await seedCompetition(tx);

        const seen = await outcomesFor(people, async (person) => ({
          ...(await createTeamViaRoute(tx, person.id, competitionId, `Tim ${person.username}`)),
          teams: await teamsCaptainedBy(tx, competitionId, person.id),
        }));

        expect(seen).toEqual({
          owner: { status: 403, code: "team_host_of_competition", teams: 0 },
          staff: { status: 403, code: "team_host_of_competition", teams: 0 },
          plainMember: { status: 201, code: undefined, teams: 1 },
          otherHost: { status: 201, code: undefined, teams: 1 },
        });
      });
    });

    it("refuses a captain's invite to the owner or staff into a forming team, and invites a plain member and another institution's owner", async () => {
      await inRollback(async (tx) => {
        const { competitionId, people } = await seedCompetition(tx);
        const teamId = await seedTeam(tx, {
          competitionId,
          captainId: people.captain.id,
          memberIds: [],
          status: "forming",
        });

        const seen = await outcomesFor(people, async (person) => ({
          ...(await inviteViaRoute(tx, people.captain.id, teamId, person.username)),
          invites: await invitesTo(tx, teamId, person.email),
        }));

        expect(seen).toEqual({
          owner: { status: 422, code: "team_invitee_host_of_competition", invites: 0 },
          staff: { status: 422, code: "team_invitee_host_of_competition", invites: 0 },
          plainMember: { status: 201, code: undefined, invites: 1 },
          otherHost: { status: 201, code: undefined, invites: 1 },
        });
      });
    });

    it("refuses a captain's invite to the owner or staff into a registered free team, and invites a plain member and another institution's owner", async () => {
      await inRollback(async (tx) => {
        const { competitionId, people } = await seedCompetition(tx);
        const teamId = await seedTeam(tx, {
          competitionId,
          captainId: people.captain.id,
          memberIds: [],
          status: "submitted",
        });

        const seen = await outcomesFor(people, async (person) => ({
          ...(await inviteViaRoute(tx, people.captain.id, teamId, person.username)),
          invites: await invitesTo(tx, teamId, person.email),
        }));

        expect(seen).toEqual({
          owner: { status: 422, code: "team_invitee_host_of_competition", invites: 0 },
          staff: { status: 422, code: "team_invitee_host_of_competition", invites: 0 },
          plainMember: { status: 201, code: undefined, invites: 1 },
          otherHost: { status: 201, code: undefined, invites: 1 },
        });
      });
    });

    it("refuses the owner and staff an invite sent to them before, so they join no forming team, and lets a plain member and another institution's owner join", async () => {
      await inRollback(async (tx) => {
        const { competitionId, registrationEndAt, people } = await seedCompetition(tx);
        const teamId = await seedTeam(tx, {
          competitionId,
          captainId: people.captain.id,
          memberIds: [],
          status: "forming",
        });

        const seen = await outcomesFor(people, async (person) => {
          const invitationId = await seedOpenInvite(tx, {
            teamId,
            captainId: people.captain.id,
            invitee: person,
            expiresAt: registrationEndAt,
          });
          return {
            ...(await acceptViaRoute(tx, person.id, invitationId)),
            seats: await activeSeatsOf(tx, teamId, person.id),
            invitation: await invitationStatusOf(tx, invitationId),
          };
        });

        expect(seen).toEqual({
          owner: { status: 403, code: "team_host_of_competition", seats: 0, invitation: "pending" },
          staff: { status: 403, code: "team_host_of_competition", seats: 0, invitation: "pending" },
          plainMember: { status: 200, code: undefined, seats: 1, invitation: "accepted" },
          otherHost: { status: 200, code: undefined, seats: 1, invitation: "accepted" },
        });
      });
    });

    it("refuses the owner and staff an invite sent to them before, so they join no registered free team, and lets a plain member and another institution's owner join with their own registration", async () => {
      await inRollback(async (tx) => {
        const { competitionId, registrationEndAt, people } = await seedCompetition(tx);
        const teamId = await seedTeam(tx, {
          competitionId,
          captainId: people.captain.id,
          memberIds: [],
          status: "submitted",
        });

        const seen = await outcomesFor(people, async (person) => {
          const invitationId = await seedOpenInvite(tx, {
            teamId,
            captainId: people.captain.id,
            invitee: person,
            expiresAt: registrationEndAt,
          });
          return {
            ...(await acceptViaRoute(tx, person.id, invitationId)),
            seats: await activeSeatsOf(tx, teamId, person.id),
            registrations: await confirmedRegistrationsOf(tx, competitionId, person.id),
            invitation: await invitationStatusOf(tx, invitationId),
          };
        });

        const refused = {
          status: 403,
          code: "team_host_of_competition",
          seats: 0,
          registrations: 0,
          invitation: "pending",
        };
        const joined = {
          status: 200,
          code: undefined,
          seats: 1,
          registrations: 1,
          invitation: "accepted",
        };
        expect(seen).toEqual({
          owner: refused,
          staff: refused,
          plainMember: joined,
          otherHost: joined,
        });
      });
    });

    it("refuses to register a forming team holding a staff member and registers nobody, and registers a team of a plain member and another institution's owner", async () => {
      await inRollback(async (tx) => {
        const { competitionId, people } = await seedCompetition(tx);
        const secondCaptain = await seedPerson(tx, "captainb");
        const teamWithStaff = await seedTeam(tx, {
          competitionId,
          captainId: people.captain.id,
          memberIds: [people.staff.id],
          status: "forming",
        });
        const teamWithoutHost = await seedTeam(tx, {
          competitionId,
          captainId: secondCaptain.id,
          memberIds: [people.plainMember.id, people.otherHost.id],
          status: "forming",
        });

        const outcomeOf = async (captainId: string, teamId: string) => ({
          ...(await registerTeamViaRoute(tx, captainId, competitionId, teamId)),
          teamStatus: await teamStatusOf(tx, teamId),
          registrations: await confirmedRegistrationsOfTeam(tx, teamId),
        });
        const seen = {
          teamWithStaff: await outcomeOf(people.captain.id, teamWithStaff),
          teamWithoutHost: await outcomeOf(secondCaptain.id, teamWithoutHost),
        };

        expect(seen).toEqual({
          teamWithStaff: {
            status: 422,
            code: "team_member_host_of_competition",
            teamStatus: "forming",
            registrations: 0,
          },
          teamWithoutHost: {
            status: 201,
            code: undefined,
            teamStatus: "submitted",
            registrations: 3,
          },
        });
      });
    });
  },
);
