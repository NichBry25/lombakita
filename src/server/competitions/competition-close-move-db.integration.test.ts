// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
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

const enqueueSpies = vi.hoisted(() => ({
  enqueueCompetitionEdited: vi.fn(),
  enqueueCompetitionCancelled: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, ...enqueueSpies };
});

// One test stands in for a failing invite move. While the flag is off, every test runs the real move.
const closeMoveState = vi.hoisted(() => ({ failNext: false }));

vi.mock("@/server/teams/registered-team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/teams/registered-team")>();
  return {
    ...actual,
    moveRegisteredTeamInvitationsToClose: (
      ...args: Parameters<typeof actual.moveRegisteredTeamInvitationsToClose>
    ) => {
      if (closeMoveState.failNext) throw new Error("the invite move failed");
      return actual.moveRegisteredTeamInvitationsToClose(...args);
    },
  };
});

import { updateCompetitionDraft } from "@/server/competitions/competition-service";
import { parseCompetitionPatchInput } from "@/server/competitions/competition-core";
import { hashToken } from "@/server/teams/team-core";

beforeAll(() => {
  closeMoveState.failNext = false;
});

beforeEach(() => {
  closeMoveState.failNext = false;
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

const seedCandidate = async (tx: Tx, label: string): Promise<{ id: string; email: string }> => {
  const username = `closemove_${label}_${uniqueSuffix()}`;
  const email = `${username}@example.test`;
  const [row] = await tx
    .insert(users)
    .values({ email, username, emailVerified: new Date(), candidateVerifiedAt: new Date() })
    .returning({ id: users.id });
  return { id: row!.id, email };
};

const seedCompetition = async (
  tx: Tx,
  input: { paid?: boolean } = {},
): Promise<{ ownerId: string; competitionId: string; oldClose: Date }> => {
  const id = uniqueSuffix();
  const ownerUsername = `closemove_owner_${id}`;
  const [owner] = await tx
    .insert(users)
    .values({
      email: `${ownerUsername}@example.test`,
      username: ownerUsername,
      emailVerified: new Date(),
      role: "recruiter",
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    })
    .returning({ id: users.id });

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `closemove-inst-${id}`,
      institutionType: "company",
      displayName: `Close Move ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: owner!.id,
    membershipRole: "institution_owner",
    status: "active",
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `closemove-comp-${id}`,
      title: `Kompetisi tim ${id}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "team",
      minTeamSize: 2,
      maxTeamSize: 4,
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
    ownerId: owner!.id,
    competitionId: competition!.id,
    oldClose: competition!.registrationEndAt!,
  };
};

const seedTeam = async (
  tx: Tx,
  input: { competitionId: string; status: "forming" | "submitted" },
): Promise<{ teamId: string; captainId: string }> => {
  const captain = await seedCandidate(tx, "captain");
  const budi = await seedCandidate(tx, "budi");

  const [team] = await tx
    .insert(teams)
    .values({
      competitionId: input.competitionId,
      captainId: captain.id,
      name: `Tim ${uniqueSuffix()}`,
      status: input.status,
    })
    .returning({ id: teams.id });

  await tx.insert(teamMemberships).values([
    { teamId: team!.id, userId: captain.id, role: "captain", status: "active" },
    { teamId: team!.id, userId: budi.id, role: "member", status: "active" },
  ]);

  if (input.status === "submitted") {
    await tx.insert(competitionRegistrations).values(
      [captain, budi].map((user) => ({
        competitionId: input.competitionId,
        studentId: user.id,
        teamId: team!.id,
        registrationType: "team" as const,
        status: "confirmed" as const,
      })),
    );
  }

  return { teamId: team!.id, captainId: captain.id };
};

const seedInvitation = async (
  tx: Tx,
  input: {
    teamId: string;
    invitedByUserId: string;
    status: "pending" | "pending_claim" | "accepted";
    expiresAt: Date;
  },
): Promise<string> => {
  const [row] = await tx
    .insert(teamInvitations)
    .values({
      teamId: input.teamId,
      invitedByUserId: input.invitedByUserId,
      invitedEmail: `invitee_${uniqueSuffix()}@example.test`,
      tokenHash: hashToken(randomUUID()),
      status: input.status,
      expiresAt: input.expiresAt,
    })
    .returning({ id: teamInvitations.id });
  return row!.id;
};

const expiryOf = async (tx: Tx, invitationId: string): Promise<number> => {
  const [row] = await tx
    .select({ expiresAt: teamInvitations.expiresAt })
    .from(teamInvitations)
    .where(eq(teamInvitations.id, invitationId));
  return row!.expiresAt.getTime();
};

const closeOf = async (tx: Tx, competitionId: string): Promise<number> => {
  const [row] = await tx
    .select({ registrationEndAt: competitions.registrationEndAt })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row!.registrationEndAt!.getTime();
};

const moveCloseTo = (tx: Tx, ownerId: string, competitionId: string, newClose: Date) =>
  updateCompetitionDraft(
    ownerId,
    competitionId,
    parseCompetitionPatchInput({ registrationEndAt: newClose.toISOString() }),
    tx as unknown as Database,
  );

describe.skipIf(skipWithoutDatabase)("moving a free competition's registration close", () => {
  it("moves every open invite of the competition's registered teams to the new close", async () => {
    await inRollback(async (tx) => {
      const { ownerId, competitionId, oldClose } = await seedCompetition(tx);
      const registered = await seedTeam(tx, { competitionId, status: "submitted" });
      const sariInvite = await seedInvitation(tx, {
        teamId: registered.teamId,
        invitedByUserId: registered.captainId,
        status: "pending",
        expiresAt: oldClose,
      });
      const claimInvite = await seedInvitation(tx, {
        teamId: registered.teamId,
        invitedByUserId: registered.captainId,
        status: "pending_claim",
        expiresAt: oldClose,
      });
      const ekoInvite = await seedInvitation(tx, {
        teamId: registered.teamId,
        invitedByUserId: registered.captainId,
        status: "accepted",
        expiresAt: oldClose,
      });
      const forming = await seedTeam(tx, { competitionId, status: "forming" });
      const formingInvite = await seedInvitation(tx, {
        teamId: forming.teamId,
        invitedByUserId: forming.captainId,
        status: "pending",
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
      });
      const formingExpiry = await expiryOf(tx, formingInvite);
      const newClose = new Date(Date.now() + 18 * DAY_MS);

      await moveCloseTo(tx, ownerId, competitionId, newClose);

      expect(await closeOf(tx, competitionId)).toBe(newClose.getTime());
      expect(await expiryOf(tx, sariInvite)).toBe(newClose.getTime());
      expect(await expiryOf(tx, claimInvite)).toBe(newClose.getTime());
      expect(await expiryOf(tx, ekoInvite)).toBe(oldClose.getTime());
      expect(await expiryOf(tx, formingInvite)).toBe(formingExpiry);
    });
  });

  it("keeps the old close when moving the invites fails, so both share the edit's transaction", async () => {
    await inRollback(async (tx) => {
      const { ownerId, competitionId, oldClose } = await seedCompetition(tx);
      const registered = await seedTeam(tx, { competitionId, status: "submitted" });
      const sariInvite = await seedInvitation(tx, {
        teamId: registered.teamId,
        invitedByUserId: registered.captainId,
        status: "pending",
        expiresAt: oldClose,
      });
      const claimInvite = await seedInvitation(tx, {
        teamId: registered.teamId,
        invitedByUserId: registered.captainId,
        status: "pending_claim",
        expiresAt: oldClose,
      });
      closeMoveState.failNext = true;

      await expect(
        moveCloseTo(tx, ownerId, competitionId, new Date(Date.now() + 18 * DAY_MS)),
      ).rejects.toThrow("the invite move failed");

      expect(await closeOf(tx, competitionId)).toBe(oldClose.getTime());
      expect(await expiryOf(tx, sariInvite)).toBe(oldClose.getTime());
      expect(await expiryOf(tx, claimInvite)).toBe(oldClose.getTime());
    });
  });

  it("leaves the invites of a paid competition alone when its close moves", async () => {
    await inRollback(async (tx) => {
      const { ownerId, competitionId, oldClose } = await seedCompetition(tx, { paid: true });
      const registered = await seedTeam(tx, { competitionId, status: "submitted" });
      const sariInvite = await seedInvitation(tx, {
        teamId: registered.teamId,
        invitedByUserId: registered.captainId,
        status: "pending",
        expiresAt: oldClose,
      });
      const newClose = new Date(Date.now() + 18 * DAY_MS);

      await moveCloseTo(tx, ownerId, competitionId, newClose);

      expect(await closeOf(tx, competitionId)).toBe(newClose.getTime());
      expect(await expiryOf(tx, sariInvite)).toBe(oldClose.getTime());
    });
  });
});
