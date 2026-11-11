// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  institutionPaymentInstructions,
  institutions,
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
      throw new Error("the team registration route read the database outside a test");
    },
  };
});

vi.mock("@/server/auth/session", () => ({
  requireSessionRole: async () => {
    if (!routeState.actorUserId) {
      throw new Error("the team registration route ran with no session staged");
    }
    return { user: { id: routeState.actorUserId, role: "candidate" } };
  },
}));

import { POST } from "@/app/api/v1/competitions/[competitionId]/teams/[teamId]/registrations/route";

beforeAll(() => {
  routeState.testRunStarted = true;
});

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

const seedCandidate = async (tx: Tx, label: string): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `pay_refusal_${label}_${id}@example.test`,
      username: `pay_refusal_${label}_${id}`,
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedFormingTeamOfPaidCompetition = async (
  tx: Tx,
): Promise<{
  captainUserId: string;
  memberUserId: string;
  competitionId: string;
  teamId: string;
}> => {
  const id = uniqueSuffix();

  const captainUserId = await seedCandidate(tx, "captain");
  const memberUserId = await seedCandidate(tx, "member");

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `pay-refusal-team-inst-${id}`,
      institutionType: "company",
      displayName: `Pay Refusal Team ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionPaymentInstructions).values({
    institutionId: institution!.id,
    bankName: "Bank Contoh",
    accountNumber: "1234567890",
    accountHolderName: "Panitia Lomba",
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `pay-refusal-team-comp-${id}`,
      title: `Pay Refusal Team ${id}`,
      status: "published",
      mode: "team",
      minTeamSize: 2,
      maxTeamSize: 4,
      registrationEndAt: new Date(Date.now() + 30 * DAY_MS),
      feeAmount: 150_000,
      feeCurrency: "IDR",
      paymentWindowDays: 3,
    })
    .returning({ id: competitions.id });

  const [team] = await tx
    .insert(teams)
    .values({
      competitionId: competition!.id,
      captainId: captainUserId,
      name: `Tim ${id}`,
      status: "forming",
    })
    .returning({ id: teams.id });

  await tx.insert(teamMemberships).values([
    { teamId: team!.id, userId: captainUserId, role: "captain", status: "active" },
    { teamId: team!.id, userId: memberUserId, role: "member", status: "active" },
  ]);

  return { captainUserId, memberUserId, competitionId: competition!.id, teamId: team!.id };
};

describe.skipIf(skipWithoutDatabase)(
  "registering a team for a priced competition through the route, against a real database",
  () => {
    beforeEach(() => {
      routeState.transaction = null;
      routeState.actorUserId = null;
    });

    it("answers 409, registers nobody and leaves the team forming when no fee rule is in force", async () => {
      await inRollback(async (tx) => {
        const { captainUserId, memberUserId, competitionId, teamId } =
          await seedFormingTeamOfPaidCompetition(tx);
        routeState.transaction = tx as unknown as Database;
        routeState.actorUserId = captainUserId;

        const response = await POST(
          new Request(
            `https://lombakita.test/api/v1/competitions/${competitionId}/teams/${teamId}/registrations`,
            { method: "POST" },
          ),
          { params: Promise.resolve({ competitionId, teamId }) },
        );
        const body = (await response.json()) as Record<string, unknown>;

        expect(response.status).toBe(409);
        expect(body).toMatchObject({ error: { code: "registration_payment_unavailable" } });

        const registrations = await tx
          .select({ id: competitionRegistrations.id })
          .from(competitionRegistrations)
          .where(
            and(
              eq(competitionRegistrations.competitionId, competitionId),
              inArray(competitionRegistrations.studentId, [captainUserId, memberUserId]),
            ),
          );
        expect(registrations).toHaveLength(0);

        const [team] = await tx
          .select({ status: teams.status })
          .from(teams)
          .where(eq(teams.id, teamId));
        expect(team!.status).toBe("forming");
      });
    });
  },
);
