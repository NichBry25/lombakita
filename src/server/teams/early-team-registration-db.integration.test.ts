// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, and, eq, inArray } from "drizzle-orm";
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

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
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
      throw new Error("a team route read the database outside a test");
    },
  };
});

vi.mock("@/server/auth/session", () => {
  const stagedSession = () => {
    if (!routeState.actorUserId) {
      throw new Error("a team route ran with no session staged");
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
  enqueueCompetitionEdited: vi.fn(),
  enqueueCompetitionCancelled: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, ...enqueueSpies };
});

import { POST as registerTeamRoute } from "@/app/api/v1/competitions/[competitionId]/teams/[teamId]/registrations/route";
import { POST as inviteRoute } from "@/app/api/v1/teams/[teamId]/invitations/route";
import { DELETE as cancelInviteRoute } from "@/app/api/v1/teams/[teamId]/invitations/[token]/route";
import { POST as acceptRoute } from "@/app/api/v1/me/invitations/team/[invitationId]/accept/route";
import { POST as declineRoute } from "@/app/api/v1/me/invitations/team/[invitationId]/decline/route";
import {
  transitionCompetitionStatus,
  unpublishCompetition,
} from "@/server/competitions/competition-service";
import {
  parseReviewUpdatePayload,
  updateRegistrationReview,
} from "@/server/participants/review-service";
import { claimPendingInvitationsForUser } from "@/server/invitations/claim-service";
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

const seedCandidate = async (
  tx: Tx,
  label: string,
  options: { email?: string; candidateVerified?: boolean } = {},
): Promise<SeededUser> => {
  const username = `early_${label}_${uniqueSuffix()}`;
  const email = options.email ?? `${username}@example.test`;
  const verifiedRole =
    options.candidateVerified === false
      ? { recruiterVerifiedAt: new Date(), recruiterVerificationTier: "minimal" as const }
      : { candidateVerifiedAt: new Date() };
  const [row] = await tx
    .insert(users)
    .values({ email, username, emailVerified: new Date(), ...verifiedRole })
    .returning({ id: users.id });
  return { id: row!.id, email, username };
};

const seedOwner = async (tx: Tx): Promise<SeededUser> => {
  const username = `early_owner_${uniqueSuffix()}`;
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
  institutionId: string;
  ownerId: string;
  competitionId: string;
  registrationEndAt: Date;
};

const seedCompetition = async (
  tx: Tx,
  input: { minTeamSize: number; maxTeamSize: number; paid?: boolean },
): Promise<SeededCompetition> => {
  const id = uniqueSuffix();
  const owner = await seedOwner(tx);

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `early-inst-${id}`,
      institutionType: "company",
      displayName: `Early Team ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: owner.id,
    membershipRole: "institution_owner",
    status: "active",
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `early-comp-${id}`,
      title: `Kompetisi tim ${id}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "team",
      minTeamSize: input.minTeamSize,
      maxTeamSize: input.maxTeamSize,
      status: "published",
      publishedAt: new Date(),
      registrationStartAt: new Date(Date.now() - 7 * DAY_MS),
      registrationEndAt: new Date(Date.now() + 14 * DAY_MS),
      participantConfirmationAt: new Date(Date.now() + 20 * DAY_MS),
      eventStartAt: new Date(Date.now() + 30 * DAY_MS),
      eventEndAt: new Date(Date.now() + 31 * DAY_MS),
      resultAnnouncementAt: new Date(Date.now() + 40 * DAY_MS),
      feeAmount: input.paid ? 150_000 : null,
      feeCurrency: input.paid ? "IDR" : null,
    })
    .returning({ id: competitions.id, registrationEndAt: competitions.registrationEndAt });

  return {
    institutionId: institution!.id,
    ownerId: owner.id,
    competitionId: competition!.id,
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

const passTheClose = async (tx: Tx, competitionId: string): Promise<Date> => {
  const closedAt = new Date(Date.now() - 60_000);
  await tx
    .update(competitions)
    .set({ registrationEndAt: closedAt })
    .where(eq(competitions.id, competitionId));
  return closedAt;
};

type RouteAnswer = { status: number; body: Record<string, unknown> };

const stageActor = (tx: Tx, userId: string): void => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = userId;
};

const readAnswer = async (response: Response): Promise<RouteAnswer> => {
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
};

const errorCodeOf = (answer: RouteAnswer): string | undefined =>
  (answer.body.error as { code?: string } | undefined)?.code;

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
  return readAnswer(response);
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
  return readAnswer(response);
};

const cancelInviteViaRoute = async (
  tx: Tx,
  captainId: string,
  teamId: string,
  tokenHash: string,
): Promise<RouteAnswer> => {
  stageActor(tx, captainId);
  const response = await cancelInviteRoute(
    new Request(`https://lombakita.test/api/v1/teams/${teamId}/invitations/${tokenHash}`, {
      method: "DELETE",
      headers: { "X-Expected-User-Id": captainId },
    }),
    { params: Promise.resolve({ teamId, token: tokenHash }) },
  );
  return readAnswer(response);
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
  return readAnswer(response);
};

const declineViaRoute = async (
  tx: Tx,
  userId: string,
  invitationId: string,
): Promise<RouteAnswer> => {
  stageActor(tx, userId);
  const response = await declineRoute(
    new Request(`https://lombakita.test/api/v1/me/invitations/team/${invitationId}/decline`, {
      method: "POST",
      headers: { "X-Expected-User-Id": userId },
    }),
    { params: Promise.resolve({ invitationId }) },
  );
  return readAnswer(response);
};

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

const invitationsToEmail = (tx: Tx, teamId: string, invitedEmail: string) =>
  tx
    .select({ id: teamInvitations.id })
    .from(teamInvitations)
    .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.invitedEmail, invitedEmail)));

const registrationsOf = (tx: Tx, competitionId: string, userIds: string[]) =>
  tx
    .select({
      id: competitionRegistrations.id,
      studentId: competitionRegistrations.studentId,
      status: competitionRegistrations.status,
      registrationType: competitionRegistrations.registrationType,
      teamId: competitionRegistrations.teamId,
    })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        inArray(competitionRegistrations.studentId, userIds),
      ),
    );

const confirmedStudentIds = async (tx: Tx, competitionId: string): Promise<string[]> => {
  const rows = await tx
    .select({ studentId: competitionRegistrations.studentId })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        eq(competitionRegistrations.status, "confirmed"),
      ),
    );
  return rows.map((row) => row.studentId).sort();
};

const activeMemberIds = async (tx: Tx, teamId: string): Promise<string[]> => {
  const rows = await tx
    .select({ userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")));
  return rows.map((row) => row.userId).sort();
};

describe.skipIf(skipWithoutDatabase)(
  "registering a free team before every member has joined",
  () => {
    it("registers a free team once joined members and open invites reach the minimum, and gives the open invites the close as their expiry", async () => {
      await inRollback(async (tx) => {
        const { competitionId, registrationEndAt } = await seedCompetition(tx, {
          minTeamSize: 3,
          maxTeamSize: 3,
        });
        const rina = await seedCandidate(tx, "rina");
        const budi = await seedCandidate(tx, "budi");
        const teamId = await seedTeam(tx, {
          competitionId,
          captainId: rina.id,
          memberIds: [budi.id],
          status: "forming",
        });
        const sariInvite = await seedInvitation(tx, {
          teamId,
          invitedByUserId: rina.id,
          status: "pending_claim",
          invitedEmail: `sari_${uniqueSuffix()}@example.test`,
          expiresAt: new Date(Date.now() + 7 * DAY_MS),
        });

        const answer = await registerTeamViaRoute(tx, rina.id, competitionId, teamId);

        expect(answer.status).toBe(201);
        expect(await teamStatusOf(tx, teamId)).toBe("submitted");
        expect(await confirmedStudentIds(tx, competitionId)).toEqual([rina.id, budi.id].sort());
        const invite = await invitationOf(tx, sariInvite.id);
        expect(invite.status).toBe("pending_claim");
        expect(invite.expiresAt.getTime()).toBe(registrationEndAt.getTime());
        expect(enqueueSpies.enqueueRegistrationConfirmed).toHaveBeenCalledTimes(2);
      });
    });

    it("refuses a free team whose joined members and open invites stay below the minimum, counting no expired invite", async () => {
      await inRollback(async (tx) => {
        const { competitionId } = await seedCompetition(tx, { minTeamSize: 3, maxTeamSize: 4 });
        const rina = await seedCandidate(tx, "rina");
        const budi = await seedCandidate(tx, "budi");
        const dewi = await seedCandidate(tx, "dewi");
        const teamId = await seedTeam(tx, {
          competitionId,
          captainId: rina.id,
          memberIds: [budi.id],
          status: "forming",
        });
        await seedInvitation(tx, {
          teamId,
          invitedByUserId: rina.id,
          status: "pending",
          invitedEmail: dewi.email,
          targetUserId: dewi.id,
          expiresAt: new Date(Date.now() - DAY_MS),
        });

        const answer = await registerTeamViaRoute(tx, rina.id, competitionId, teamId);

        expect(answer.status).toBe(422);
        expect(errorCodeOf(answer)).toBe("team_size_insufficient");
        expect(await teamStatusOf(tx, teamId)).toBe("forming");
        expect(await confirmedStudentIds(tx, competitionId)).toEqual([]);
      });
    });

    it("refuses a free team whose joined members and open invites pass the maximum", async () => {
      await inRollback(async (tx) => {
        const { competitionId } = await seedCompetition(tx, { minTeamSize: 2, maxTeamSize: 3 });
        const rina = await seedCandidate(tx, "rina");
        const budi = await seedCandidate(tx, "budi");
        const teamId = await seedTeam(tx, {
          competitionId,
          captainId: rina.id,
          memberIds: [budi.id],
          status: "forming",
        });
        for (const label of ["sari", "eko"]) {
          await seedInvitation(tx, {
            teamId,
            invitedByUserId: rina.id,
            status: "pending_claim",
            invitedEmail: `${label}_${uniqueSuffix()}@example.test`,
            expiresAt: new Date(Date.now() + 7 * DAY_MS),
          });
        }

        const answer = await registerTeamViaRoute(tx, rina.id, competitionId, teamId);

        expect(answer.status).toBe(422);
        expect(errorCodeOf(answer)).toBe("team_size_exceeded");
        expect(await teamStatusOf(tx, teamId)).toBe("forming");
        expect(await confirmedStudentIds(tx, competitionId)).toEqual([]);
      });
    });

    it("cancels the invites that had already expired when a free team registers", async () => {
      await inRollback(async (tx) => {
        const { competitionId, registrationEndAt } = await seedCompetition(tx, {
          minTeamSize: 2,
          maxTeamSize: 3,
        });
        const rina = await seedCandidate(tx, "rina");
        const budi = await seedCandidate(tx, "budi");
        const dewi = await seedCandidate(tx, "dewi");
        const teamId = await seedTeam(tx, {
          competitionId,
          captainId: rina.id,
          memberIds: [budi.id],
          status: "forming",
        });
        const expiredInvite = await seedInvitation(tx, {
          teamId,
          invitedByUserId: rina.id,
          status: "pending",
          invitedEmail: dewi.email,
          targetUserId: dewi.id,
          expiresAt: new Date(Date.now() - DAY_MS),
        });
        const openInvite = await seedInvitation(tx, {
          teamId,
          invitedByUserId: rina.id,
          status: "pending_claim",
          invitedEmail: `sari_${uniqueSuffix()}@example.test`,
          expiresAt: new Date(Date.now() + 7 * DAY_MS),
        });

        const answer = await registerTeamViaRoute(tx, rina.id, competitionId, teamId);

        expect(answer.status).toBe(201);
        const expired = await invitationOf(tx, expiredInvite.id);
        expect(expired.status).toBe("cancelled");
        expect(expired.expiresAt.getTime()).toBe(expiredInvite.expiresAt.getTime());
        const open = await invitationOf(tx, openInvite.id);
        expect(open.status).toBe("pending_claim");
        expect(open.expiresAt.getTime()).toBe(registrationEndAt.getTime());
      });
    });

    it("still needs every member joined before a paid team registers", async () => {
      await inRollback(async (tx) => {
        const { competitionId } = await seedCompetition(tx, {
          minTeamSize: 3,
          maxTeamSize: 4,
          paid: true,
        });
        const rina = await seedCandidate(tx, "rina");
        const budi = await seedCandidate(tx, "budi");
        const dewi = await seedCandidate(tx, "dewi");
        const teamId = await seedTeam(tx, {
          competitionId,
          captainId: rina.id,
          memberIds: [budi.id],
          status: "forming",
        });
        const dewiInvite = await openInviteToUser(
          tx,
          teamId,
          rina.id,
          dewi,
          new Date(Date.now() + 7 * DAY_MS),
        );

        const answer = await registerTeamViaRoute(tx, rina.id, competitionId, teamId);

        expect(answer.status).toBe(422);
        expect(errorCodeOf(answer)).toBe("team_size_insufficient");
        expect(await teamStatusOf(tx, teamId)).toBe("forming");
        expect(await confirmedStudentIds(tx, competitionId)).toEqual([]);
        const invite = await invitationOf(tx, dewiInvite.id);
        expect(invite.expiresAt.getTime()).toBe(dewiInvite.expiresAt.getTime());
      });
    });
  },
);

describe.skipIf(skipWithoutDatabase)("inviting and cancelling on a registered free team", () => {
  it("invites a teammate into the last open seat of a registered free team, open until the close", async () => {
    await inRollback(async (tx) => {
      const { competitionId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });

      const answer = await inviteViaRoute(tx, rina.id, teamId, dewi.username);

      expect(answer.status).toBe(201);
      const created = answer.body.invitation as { id: string };
      const invite = await invitationOf(tx, created.id);
      expect(invite.status).toBe("pending");
      expect(invite.targetUserId).toBe(dewi.id);
      expect(invite.expiresAt.getTime()).toBe(registrationEndAt.getTime());
      expect(enqueueSpies.enqueueTeamInvitationDispatch).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses an invite that would take a registered free team past its maximum", async () => {
    await inRollback(async (tx) => {
      const { competitionId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      await seedInvitation(tx, {
        teamId,
        invitedByUserId: rina.id,
        status: "pending_claim",
        invitedEmail: `sari_${uniqueSuffix()}@example.test`,
        expiresAt: registrationEndAt,
      });

      const answer = await inviteViaRoute(tx, rina.id, teamId, dewi.username);

      expect(answer.status).toBe(422);
      expect(errorCodeOf(answer)).toBe("team_at_capacity");
      expect(await invitationsToEmail(tx, teamId, dewi.email)).toHaveLength(0);
    });
  });

  it("keeps a registered free team registered when a declined and a cancelled invite leave it short, and lets the captain invite someone else", async () => {
    await inRollback(async (tx) => {
      const { competitionId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 4,
        maxTeamSize: 4,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const eko = await seedCandidate(tx, "eko");
      const dewi = await seedCandidate(tx, "dewi");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(tx, teamId, rina.id, sari, registrationEndAt);
      const ekoInvite = await openInviteToUser(tx, teamId, rina.id, eko, registrationEndAt);

      const declined = await declineViaRoute(tx, sari.id, sariInvite.id);
      const cancelled = await cancelInviteViaRoute(tx, rina.id, teamId, ekoInvite.tokenHash);

      expect(declined.status).toBe(200);
      expect(cancelled.status).toBe(200);
      expect((await invitationOf(tx, ekoInvite.id)).status).toBe("cancelled");
      expect(await teamStatusOf(tx, teamId)).toBe("submitted");
      const registrations = await registrationsOf(tx, competitionId, [rina.id, budi.id]);
      expect(registrations.map((row) => row.status)).toEqual(["confirmed", "confirmed"]);

      const reinvited = await inviteViaRoute(tx, rina.id, teamId, dewi.username);
      expect(reinvited.status).toBe(201);
    });
  });

  it("refuses an invite to a registered team once registration has closed", async () => {
    await inRollback(async (tx) => {
      const { competitionId } = await seedCompetition(tx, { minTeamSize: 2, maxTeamSize: 3 });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      await passTheClose(tx, competitionId);

      const answer = await inviteViaRoute(tx, rina.id, teamId, dewi.username);

      expect(answer.status).toBe(422);
      expect(errorCodeOf(answer)).toBe("team_competition_registration_closed");
      expect(await invitationsToEmail(tx, teamId, dewi.email)).toHaveLength(0);
    });
  });

  it("takes no invite on a registered paid team, as today", async () => {
    await inRollback(async (tx) => {
      const { competitionId } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
        paid: true,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });

      const answer = await inviteViaRoute(tx, rina.id, teamId, dewi.username);

      expect(answer.status).toBe(409);
      expect(errorCodeOf(answer)).toBe("team_not_forming");
      expect(await invitationsToEmail(tx, teamId, dewi.email)).toHaveLength(0);
    });
  });

  it("takes no cancellation on a registered paid team, as today", async () => {
    await inRollback(async (tx) => {
      const { competitionId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
        paid: true,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(tx, teamId, rina.id, sari, registrationEndAt);

      const answer = await cancelInviteViaRoute(tx, rina.id, teamId, sariInvite.tokenHash);

      expect(answer.status).toBe(409);
      expect(errorCodeOf(answer)).toBe("team_not_forming");
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("pending");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("accepting an invite of a registered free team", () => {
  it("a teammate who accepts before the close joins the registered team with a confirmed registration and a confirmation notice", async () => {
    await inRollback(async (tx) => {
      const { competitionId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(tx, teamId, rina.id, sari, registrationEndAt);

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(200);
      expect(answer.body.teamId).toBe(teamId);
      expect(await activeMemberIds(tx, teamId)).toContain(sari.id);
      const registrations = await registrationsOf(tx, competitionId, [sari.id]);
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({
        status: "confirmed",
        registrationType: "team",
        teamId,
      });
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("accepted");
      expect(enqueueSpies.enqueueRegistrationConfirmed).toHaveBeenCalledTimes(1);
      expect(enqueueSpies.enqueueRegistrationConfirmed).toHaveBeenCalledWith({
        registrationId: registrations[0]!.id,
        studentId: sari.id,
        competitionId,
        registrationType: "team",
      });
    });
  });

  it("an email invite claimed at signup can be accepted into the registered team", async () => {
    await inRollback(async (tx) => {
      const { competitionId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariEmail = `sari_${uniqueSuffix()}@example.test`;
      const claimInvite = await seedInvitation(tx, {
        teamId,
        invitedByUserId: rina.id,
        status: "pending_claim",
        invitedEmail: sariEmail,
        expiresAt: registrationEndAt,
      });
      const sari = await seedCandidate(tx, "sari", { email: sariEmail });
      await claimPendingInvitationsForUser(sari.id, sariEmail, tx);

      const answer = await acceptViaRoute(tx, sari.id, claimInvite.id);

      expect(answer.status).toBe(200);
      const registrations = await registrationsOf(tx, competitionId, [sari.id]);
      expect(registrations.map((row) => row.status)).toEqual(["confirmed"]);
      expect(registrations[0]!.teamId).toBe(teamId);
    });
  });

  it("refuses an accept after the registration close even when the invite's stored expiry is later", async () => {
    await inRollback(async (tx) => {
      const { competitionId } = await seedCompetition(tx, { minTeamSize: 2, maxTeamSize: 3 });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        rina.id,
        sari,
        new Date(Date.now() + 7 * DAY_MS),
      );
      await passTheClose(tx, competitionId);

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(422);
      expect(errorCodeOf(answer)).toBe("team_competition_registration_closed");
      expect(await activeMemberIds(tx, teamId)).not.toContain(sari.id);
      expect(await registrationsOf(tx, competitionId, [sari.id])).toHaveLength(0);
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("pending");
    });
  });

  it("refuses a closed invite before it looks at the invitee's account", async () => {
    await inRollback(async (tx) => {
      const { competitionId } = await seedCompetition(tx, { minTeamSize: 2, maxTeamSize: 3 });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari", { candidateVerified: false });
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        rina.id,
        sari,
        new Date(Date.now() + 7 * DAY_MS),
      );
      await passTheClose(tx, competitionId);

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(422);
      expect(errorCodeOf(answer)).toBe("team_competition_registration_closed");
    });
  });

  it("says registration has closed when the invite expired at the close", async () => {
    await inRollback(async (tx) => {
      const { competitionId } = await seedCompetition(tx, { minTeamSize: 2, maxTeamSize: 3 });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const closedAt = await passTheClose(tx, competitionId);
      const sariInvite = await openInviteToUser(tx, teamId, rina.id, sari, closedAt);

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(422);
      expect(errorCodeOf(answer)).toBe("team_competition_registration_closed");
      expect(await activeMemberIds(tx, teamId)).not.toContain(sari.id);
    });
  });

  it("refuses an invite whose own expiry has passed, as an expired invite", async () => {
    await inRollback(async (tx) => {
      const { competitionId } = await seedCompetition(tx, { minTeamSize: 2, maxTeamSize: 3 });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        rina.id,
        sari,
        new Date(Date.now() - 60_000),
      );

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(410);
      expect(errorCodeOf(answer)).toBe("team_invite_not_actionable");
      expect(await activeMemberIds(tx, teamId)).not.toContain(sari.id);
    });
  });

  it("refuses an accept after the host unpublishes the competition", async () => {
    await inRollback(async (tx) => {
      const { competitionId, ownerId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(tx, teamId, rina.id, sari, registrationEndAt);
      await unpublishCompetition(ownerId, competitionId, tx as unknown as Database);

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(410);
      expect(errorCodeOf(answer)).toBe("team_invite_not_actionable");
      expect(await activeMemberIds(tx, teamId)).not.toContain(sari.id);
      expect(await registrationsOf(tx, competitionId, [sari.id])).toHaveLength(0);
    });
  });

  it("refuses an accept into a team of a cancelled competition", async () => {
    await inRollback(async (tx) => {
      const { competitionId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(tx, teamId, rina.id, sari, registrationEndAt);
      // The cancellation-state check on competitions accepts a cancelled row only with these
      // companion values, so they are set in the same update as cancelledAt.
      await tx
        .update(competitions)
        .set({
          registrationEndAt: new Date(Date.now() - 3 * DAY_MS),
          participantConfirmationAt: new Date(Date.now() - 2 * DAY_MS),
          minimumParticipantEntries: 1,
          cancellationReason: "insufficient_participants",
          cancelledAt: new Date(),
        })
        .where(eq(competitions.id, competitionId));

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(422);
      expect(errorCodeOf(answer)).toBe("team_competition_not_published");
      expect(await activeMemberIds(tx, teamId)).not.toContain(sari.id);
    });
  });

  it("refuses an accept into a registered paid team as today, even after its registration close", async () => {
    await inRollback(async (tx) => {
      const { competitionId } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
        paid: true,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(
        tx,
        teamId,
        rina.id,
        sari,
        new Date(Date.now() + 7 * DAY_MS),
      );
      await passTheClose(tx, competitionId);

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(409);
      expect(errorCodeOf(answer)).toBe("team_not_forming");
      expect(await activeMemberIds(tx, teamId)).not.toContain(sari.id);
      expect(await registrationsOf(tx, competitionId, [sari.id])).toHaveLength(0);
    });
  });

  it("refuses an accept that would take a registered free team past its maximum", async () => {
    await inRollback(async (tx) => {
      const { competitionId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 3,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const dewi = await seedCandidate(tx, "dewi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id, dewi.id],
        status: "submitted",
      });
      // Inserted directly to stand for a race: the invite was sent while a seat was free.
      const sariInvite = await openInviteToUser(tx, teamId, rina.id, sari, registrationEndAt);

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(422);
      expect(errorCodeOf(answer)).toBe("team_at_capacity");
      expect(await activeMemberIds(tx, teamId)).not.toContain(sari.id);
      expect(await registrationsOf(tx, competitionId, [sari.id])).toHaveLength(0);
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("pending");
    });
  });

  it("refuses an accept and an invite on a team whose registration an unpublish cancelled, once the competition is published again", async () => {
    await inRollback(async (tx) => {
      const { competitionId, ownerId, registrationEndAt } = await seedCompetition(tx, {
        minTeamSize: 2,
        maxTeamSize: 4,
      });
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const dewi = await seedCandidate(tx, "dewi");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(tx, teamId, rina.id, sari, registrationEndAt);
      // Publishing needs an organiser contact, which the seed leaves out.
      await tx
        .update(competitions)
        .set({ organizerContactKind: "whatsapp", organizerContactValue: "628123456789" })
        .where(eq(competitions.id, competitionId));
      await unpublishCompetition(ownerId, competitionId, tx as unknown as Database);
      await transitionCompetitionStatus(
        ownerId,
        competitionId,
        "published",
        tx as unknown as Database,
      );

      expect(await teamStatusOf(tx, teamId)).toBe("cancelled");

      const accept = await acceptViaRoute(tx, sari.id, sariInvite.id);
      const invite = await inviteViaRoute(tx, rina.id, teamId, dewi.username);

      expect([
        { status: accept.status, code: errorCodeOf(accept) },
        { status: invite.status, code: errorCodeOf(invite) },
      ]).toEqual([
        { status: 410, code: "team_invite_not_actionable" },
        { status: 409, code: "team_not_forming" },
      ]);
      expect(await activeMemberIds(tx, teamId)).not.toContain(sari.id);
      expect(await registrationsOf(tx, competitionId, [sari.id])).toHaveLength(0);
      expect(await invitationsToEmail(tx, teamId, dewi.email)).toHaveLength(0);
      expect((await invitationOf(tx, sariInvite.id)).status).toBe("cancelled");
    });
  });

  it("a teammate who joins a reviewed team takes the team's review status and note", async () => {
    await inRollback(async (tx) => {
      const { institutionId, ownerId, competitionId, registrationEndAt } = await seedCompetition(
        tx,
        { minTeamSize: 2, maxTeamSize: 3 },
      );
      const rina = await seedCandidate(tx, "rina");
      const budi = await seedCandidate(tx, "budi");
      const sari = await seedCandidate(tx, "sari");
      const teamId = await seedTeam(tx, {
        competitionId,
        captainId: rina.id,
        memberIds: [budi.id],
        status: "submitted",
      });
      const sariInvite = await openInviteToUser(tx, teamId, rina.id, sari, registrationEndAt);
      const [ownerMembership] = await tx
        .select({ id: institutionMemberships.id })
        .from(institutionMemberships)
        .where(eq(institutionMemberships.userId, ownerId));
      const [rinaRegistration] = await registrationsOf(tx, competitionId, [rina.id]);
      await updateRegistrationReview(
        institutionId,
        competitionId,
        rinaRegistration!.id,
        parseReviewUpdatePayload({
          internalReviewStatus: "shortlisted",
          internalNotes: "Proposal kuat",
        }),
        ownerMembership!.id,
        tx as unknown as Database,
      );

      const answer = await acceptViaRoute(tx, sari.id, sariInvite.id);

      expect(answer.status).toBe(200);
      const [sariRegistration] = await tx
        .select({
          internalReviewStatus: competitionRegistrations.internalReviewStatus,
          internalNotes: competitionRegistrations.internalNotes,
        })
        .from(competitionRegistrations)
        .where(
          and(
            eq(competitionRegistrations.competitionId, competitionId),
            eq(competitionRegistrations.studentId, sari.id),
          ),
        );
      expect(sariRegistration).toEqual({
        internalReviewStatus: "shortlisted",
        internalNotes: "Proposal kuat",
      });
    });
  });
});
