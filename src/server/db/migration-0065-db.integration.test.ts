// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TransactionRollbackError, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { competitions, institutions, teamInvitations, teams, users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
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

const MIGRATION = resolve(process.cwd(), "drizzle/0065_team_invitations_expire_at_close.sql");

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

const seedInstitution = async (tx: Tx): Promise<string> => {
  const id = uniqueSuffix();
  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `mig65-inst-${id}`,
      institutionType: "company",
      displayName: `Mig 65 ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });
  return institution!.id;
};

type CompetitionShape = {
  status: "draft" | "published";
  registrationStartAt: Date;
  registrationEndAt: Date;
  deletedAt: Date | null;
};

const seedCompetition = async (
  tx: Tx,
  institutionId: string,
  shape: CompetitionShape,
): Promise<string> => {
  const id = uniqueSuffix();
  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId,
      slug: `mig65-comp-${id}`,
      title: `Kompetisi tim ${id}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "team",
      minTeamSize: 2,
      maxTeamSize: 4,
      status: shape.status,
      publishedAt: shape.status === "published" ? new Date() : null,
      registrationStartAt: shape.registrationStartAt,
      registrationEndAt: shape.registrationEndAt,
      participantConfirmationAt: new Date(Date.now() + 20 * DAY_MS),
      eventStartAt: new Date(Date.now() + 30 * DAY_MS),
      eventEndAt: new Date(Date.now() + 31 * DAY_MS),
      resultAnnouncementAt: new Date(Date.now() + 40 * DAY_MS),
      deletedAt: shape.deletedAt,
    })
    .returning({ id: competitions.id });
  return competition!.id;
};

const seedFormingTeam = async (
  tx: Tx,
  competitionId: string,
): Promise<{ teamId: string; captainId: string }> => {
  const username = `mig65_captain_${uniqueSuffix()}`;
  const [captain] = await tx
    .insert(users)
    .values({
      email: `${username}@example.test`,
      username,
      emailVerified: new Date(),
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });

  const [team] = await tx
    .insert(teams)
    .values({
      competitionId,
      captainId: captain!.id,
      name: `Tim ${uniqueSuffix()}`,
      status: "forming",
    })
    .returning({ id: teams.id });

  return { teamId: team!.id, captainId: captain!.id };
};

const seedInvitation = async (
  tx: Tx,
  team: { teamId: string; captainId: string },
  status: "pending" | "pending_claim" | "accepted" | "declined" | "cancelled",
  expiresAt: Date,
): Promise<string> => {
  const [row] = await tx
    .insert(teamInvitations)
    .values({
      teamId: team.teamId,
      invitedByUserId: team.captainId,
      invitedEmail: `mig65_invitee_${uniqueSuffix()}@example.test`,
      tokenHash: hashToken(randomUUID()),
      status,
      expiresAt,
    })
    .returning({ id: teamInvitations.id });
  return row!.id;
};

const expiriesOf = async (
  tx: Tx,
  invitationIds: Record<string, string>,
): Promise<Record<string, number | undefined>> => {
  const rows = await tx
    .select({ id: teamInvitations.id, expiresAt: teamInvitations.expiresAt })
    .from(teamInvitations)
    .where(inArray(teamInvitations.id, Object.values(invitationIds)));
  const expiryById = new Map(rows.map((row) => [row.id, row.expiresAt.getTime()]));
  return Object.fromEntries(
    Object.entries(invitationIds).map(([name, id]) => [name, expiryById.get(id)]),
  );
};

describe.skipIf(skipWithoutDatabase)("migration 0065 against the database", () => {
  it("moves every unanswered invite of a live competition to its close, leaves every other invite alone, and changes nothing when run again", async () => {
    await inRollback(async (tx) => {
      const now = Date.now();
      const openClose = new Date(now + 14 * DAY_MS);
      const weekOut = new Date(now + 7 * DAY_MS);
      const dayAgo = new Date(now - DAY_MS);
      const twoDaysAgo = new Date(now - 2 * DAY_MS);
      const institutionId = await seedInstitution(tx);
      const openCompetition = await seedCompetition(tx, institutionId, {
        status: "published",
        registrationStartAt: new Date(now - 7 * DAY_MS),
        registrationEndAt: openClose,
        deletedAt: null,
      });
      const closedCompetition = await seedCompetition(tx, institutionId, {
        status: "published",
        registrationStartAt: new Date(now - 10 * DAY_MS),
        registrationEndAt: dayAgo,
        deletedAt: null,
      });
      const deletedCompetition = await seedCompetition(tx, institutionId, {
        status: "draft",
        registrationStartAt: new Date(now - 7 * DAY_MS),
        registrationEndAt: openClose,
        deletedAt: new Date(),
      });
      const openTeam = await seedFormingTeam(tx, openCompetition);
      const closedTeam = await seedFormingTeam(tx, closedCompetition);
      const deletedTeam = await seedFormingTeam(tx, deletedCompetition);
      const invitationIds = {
        pendingWeek: await seedInvitation(tx, openTeam, "pending", weekOut),
        pendingLapsed: await seedInvitation(tx, openTeam, "pending", dayAgo),
        claimWeek: await seedInvitation(tx, openTeam, "pending_claim", weekOut),
        accepted: await seedInvitation(tx, openTeam, "accepted", weekOut),
        declined: await seedInvitation(tx, openTeam, "declined", weekOut),
        cancelled: await seedInvitation(tx, openTeam, "cancelled", weekOut),
        passedClose: await seedInvitation(tx, closedTeam, "pending", twoDaysAgo),
        deletedDraft: await seedInvitation(tx, deletedTeam, "pending", weekOut),
      };

      const migration = sql.raw(readFileSync(MIGRATION, "utf8"));
      await tx.execute(migration);
      const afterFirst = await expiriesOf(tx, invitationIds);
      const secondRun = await tx.execute(migration);
      const afterSecond = await expiriesOf(tx, invitationIds);

      const expected = {
        pendingWeek: openClose.getTime(),
        pendingLapsed: openClose.getTime(),
        claimWeek: openClose.getTime(),
        accepted: weekOut.getTime(),
        declined: weekOut.getTime(),
        cancelled: weekOut.getTime(),
        passedClose: twoDaysAgo.getTime(),
        deletedDraft: weekOut.getTime(),
      };
      expect({ afterFirst, afterSecond, secondRunChanged: secondRun.count }).toEqual({
        afterFirst: expected,
        afterSecond: expected,
        secondRunChanged: 0,
      });
    });
  });
});
