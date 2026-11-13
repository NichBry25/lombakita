// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
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
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { listCompetitionParticipants } from "@/server/participants/participant-service";
import { hashToken } from "@/server/teams/team-core";

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

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

type SeededUser = { id: string; email: string; username: string };

const seedCandidate = async (tx: Tx, label: string): Promise<SeededUser> => {
  const username = `pending_${label}_${uniqueSuffix()}`;
  const email = `${username}@example.test`;
  const [row] = await tx
    .insert(users)
    .values({ email, username, emailVerified: new Date(), candidateVerifiedAt: new Date() })
    .returning({ id: users.id });
  return { id: row!.id, email, username };
};

const seedCompetition = async (
  tx: Tx,
  input: { paid?: boolean } = {},
): Promise<{ institutionId: string; competitionId: string }> => {
  const id = uniqueSuffix();

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `pending-inst-${id}`,
      institutionType: "company",
      displayName: `Pending Teammates ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `pending-comp-${id}`,
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
    .returning({ id: competitions.id });

  return { institutionId: institution!.id, competitionId: competition!.id };
};

const seedTeamOfTwo = async (
  tx: Tx,
  input: {
    competitionId: string;
    teamStatus: "forming" | "submitted";
    registrationStatus: "confirmed" | "cancelled";
  },
): Promise<{ teamId: string; captain: SeededUser }> => {
  const captain = await seedCandidate(tx, "rina");
  const budi = await seedCandidate(tx, "budi");

  const [team] = await tx
    .insert(teams)
    .values({
      competitionId: input.competitionId,
      captainId: captain.id,
      name: `Tim ${uniqueSuffix()}`,
      status: input.teamStatus,
    })
    .returning({ id: teams.id });

  await tx.insert(teamMemberships).values([
    { teamId: team!.id, userId: captain.id, role: "captain", status: "active" },
    { teamId: team!.id, userId: budi.id, role: "member", status: "active" },
  ]);

  await tx.insert(competitionRegistrations).values(
    [captain, budi].map((user) => ({
      competitionId: input.competitionId,
      studentId: user.id,
      teamId: team!.id,
      registrationType: "team" as const,
      status: input.registrationStatus,
      registeredAt: new Date(),
    })),
  );

  return { teamId: team!.id, captain };
};

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
): Promise<string> => {
  const [row] = await tx
    .insert(teamInvitations)
    .values({
      teamId: input.teamId,
      invitedByUserId: input.invitedByUserId,
      invitedEmail: input.invitedEmail,
      targetUserId: input.targetUserId ?? null,
      tokenHash: hashToken(randomUUID()),
      status: input.status,
      expiresAt: input.expiresAt,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: teamInvitations.id });
  return row!.id;
};

const listFor = (tx: Tx, institutionId: string, competitionId: string) =>
  listCompetitionParticipants(institutionId, competitionId, {}, tx as unknown as Database);

const OPEN_UNTIL = () => new Date(Date.now() + 14 * DAY_MS);

describe.skipIf(skipWithoutDatabase)(
  "the organiser's list of teammates who have not joined",
  () => {
    it("shows a pending teammate by username and an email invite without its address", async () => {
      await inRollback(async (tx) => {
        const { institutionId, competitionId } = await seedCompetition(tx);
        const { teamId, captain } = await seedTeamOfTwo(tx, {
          competitionId,
          teamStatus: "submitted",
          registrationStatus: "confirmed",
        });
        const dewi = await seedCandidate(tx, "dewi");
        const sariEmail = `sari_${uniqueSuffix()}@example.test`;
        // Both rows share one transaction, so createdAt is set by hand to fix the order.
        const dewiInvite = await seedInvitation(tx, {
          teamId,
          invitedByUserId: captain.id,
          status: "pending",
          invitedEmail: dewi.email,
          targetUserId: dewi.id,
          expiresAt: OPEN_UNTIL(),
          createdAt: new Date(Date.now() - 2 * MINUTE_MS),
        });
        const sariInvite = await seedInvitation(tx, {
          teamId,
          invitedByUserId: captain.id,
          status: "pending_claim",
          invitedEmail: sariEmail,
          expiresAt: OPEN_UNTIL(),
          createdAt: new Date(Date.now() - 1 * MINUTE_MS),
        });

        const result = await listFor(tx, institutionId, competitionId);

        expect(result.participants).toHaveLength(1);
        expect(result.participants[0]!.team!.pendingTeammates).toEqual([
          { invitationId: dewiInvite, username: dewi.username },
          { invitationId: sariInvite, username: null },
        ]);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(sariEmail);
        expect(serialized).not.toContain(dewi.email);
      });
    });

    it("shows no pending teammate of another institution's competition", async () => {
      await inRollback(async (tx) => {
        const first = await seedCompetition(tx);
        const second = await seedCompetition(tx);
        const firstTeam = await seedTeamOfTwo(tx, {
          competitionId: first.competitionId,
          teamStatus: "submitted",
          registrationStatus: "confirmed",
        });
        const secondTeam = await seedTeamOfTwo(tx, {
          competitionId: second.competitionId,
          teamStatus: "submitted",
          registrationStatus: "confirmed",
        });
        const firstInvite = await seedInvitation(tx, {
          teamId: firstTeam.teamId,
          invitedByUserId: firstTeam.captain.id,
          status: "pending_claim",
          invitedEmail: `eko_${uniqueSuffix()}@example.test`,
          expiresAt: OPEN_UNTIL(),
        });
        const secondInvite = await seedInvitation(tx, {
          teamId: secondTeam.teamId,
          invitedByUserId: secondTeam.captain.id,
          status: "pending_claim",
          invitedEmail: `sari_${uniqueSuffix()}@example.test`,
          expiresAt: OPEN_UNTIL(),
        });

        const crossInstitution = await listFor(tx, first.institutionId, second.competitionId);
        const own = await listFor(tx, second.institutionId, second.competitionId);

        expect(crossInstitution.participants).toHaveLength(0);
        expect(own.participants[0]!.team!.pendingTeammates).toEqual([
          { invitationId: secondInvite, username: null },
        ]);
        expect(JSON.stringify(own)).not.toContain(firstInvite);
      });
    });

    it("shows no pending teammate on a paid competition, as today", async () => {
      await inRollback(async (tx) => {
        const { institutionId, competitionId } = await seedCompetition(tx, { paid: true });
        const { teamId, captain } = await seedTeamOfTwo(tx, {
          competitionId,
          teamStatus: "submitted",
          registrationStatus: "confirmed",
        });
        await seedInvitation(tx, {
          teamId,
          invitedByUserId: captain.id,
          status: "pending_claim",
          invitedEmail: `sari_${uniqueSuffix()}@example.test`,
          expiresAt: OPEN_UNTIL(),
        });

        const result = await listFor(tx, institutionId, competitionId);

        expect(result.participants).toHaveLength(1);
        expect(result.participants[0]!.team!.pendingTeammates).toEqual([]);
      });
    });

    it("shows no pending teammate on a deleted competition", async () => {
      await inRollback(async (tx) => {
        const { institutionId, competitionId } = await seedCompetition(tx);
        const { teamId, captain } = await seedTeamOfTwo(tx, {
          competitionId,
          teamStatus: "submitted",
          registrationStatus: "confirmed",
        });
        await seedInvitation(tx, {
          teamId,
          invitedByUserId: captain.id,
          status: "pending_claim",
          invitedEmail: `sari_${uniqueSuffix()}@example.test`,
          expiresAt: OPEN_UNTIL(),
        });
        await tx
          .update(competitions)
          .set({ deletedAt: new Date() })
          .where(eq(competitions.id, competitionId));

        const result = await listFor(tx, institutionId, competitionId);

        expect(result.participants).toHaveLength(1);
        expect(result.participants[0]!.team!.pendingTeammates).toEqual([]);
      });
    });

    it("leaves out invites that expired or were answered", async () => {
      await inRollback(async (tx) => {
        const { institutionId, competitionId } = await seedCompetition(tx);
        const { teamId, captain } = await seedTeamOfTwo(tx, {
          competitionId,
          teamStatus: "submitted",
          registrationStatus: "confirmed",
        });
        const invite = (
          label: string,
          status: "pending" | "accepted" | "declined" | "cancelled",
          expiresAt: Date,
        ) =>
          seedInvitation(tx, {
            teamId,
            invitedByUserId: captain.id,
            status,
            invitedEmail: `${label}_${uniqueSuffix()}@example.test`,
            expiresAt,
          });
        await invite("expired", "pending", new Date(Date.now() - MINUTE_MS));
        await invite("accepted", "accepted", OPEN_UNTIL());
        await invite("declined", "declined", OPEN_UNTIL());
        await invite("cancelled", "cancelled", OPEN_UNTIL());

        const result = await listFor(tx, institutionId, competitionId);

        expect(result.participants[0]!.team!.pendingTeammates).toEqual([]);
      });
    });

    it("shows no pending teammate of a team whose registration was cancelled", async () => {
      await inRollback(async (tx) => {
        const { institutionId, competitionId } = await seedCompetition(tx);
        const { teamId, captain } = await seedTeamOfTwo(tx, {
          competitionId,
          teamStatus: "forming",
          registrationStatus: "cancelled",
        });
        await seedInvitation(tx, {
          teamId,
          invitedByUserId: captain.id,
          status: "pending_claim",
          invitedEmail: `sari_${uniqueSuffix()}@example.test`,
          expiresAt: OPEN_UNTIL(),
        });

        const result = await listFor(tx, institutionId, competitionId);

        expect(result.participants).toHaveLength(1);
        expect(result.participants[0]!.team!.pendingTeammates).toEqual([]);
      });
    });
  },
);
