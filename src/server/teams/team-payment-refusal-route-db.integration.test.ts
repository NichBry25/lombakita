// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  financeFeeRules,
  financePayments,
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
  { withFeeRule }: { withFeeRule: boolean },
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

  if (withFeeRule) {
    await tx.insert(financeFeeRules).values({
      institutionId: institution!.id,
      currency: "IDR",
      basisPoints: 250,
      flatAmount: 0,
      effectiveFrom: new Date(Date.now() - 30 * DAY_MS),
    });
  }

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

const registerTeamViaRoute = async (
  tx: Tx,
  captainUserId: string,
  competitionId: string,
  teamId: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
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
  return { status: response.status, body };
};

const registeredStudentIds = async (
  tx: Tx,
  competitionId: string,
  userIds: string[],
): Promise<string[]> => {
  const rows = await tx
    .select({ studentId: competitionRegistrations.studentId })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        inArray(competitionRegistrations.studentId, userIds),
      ),
    );
  return rows.map((row) => row.studentId);
};

const teamStatus = async (tx: Tx, teamId: string) => {
  const [team] = await tx.select({ status: teams.status }).from(teams).where(eq(teams.id, teamId));
  return team!.status;
};

const paymentsPaidBy = async (tx: Tx, payerUserId: string) =>
  tx
    .select({ id: financePayments.id })
    .from(financePayments)
    .where(eq(financePayments.payerUserId, payerUserId));

const platformWideFeeRules = async (tx: Tx) =>
  tx
    .select({ id: financeFeeRules.id })
    .from(financeFeeRules)
    .where(isNull(financeFeeRules.institutionId));

describe.skipIf(skipWithoutDatabase)(
  "registering a team for a priced competition through the route, against a real database",
  () => {
    beforeEach(() => {
      routeState.transaction = null;
      routeState.actorUserId = null;
    });

    it("answers 409, registers nobody and leaves the team forming when no fee rule is in force", async () => {
      await inRollback(async (tx) => {
        expect(
          await platformWideFeeRules(tx),
          "the test database holds a platform-wide fee rule, so no fee rule in force cannot be staged",
        ).toHaveLength(0);
        const { captainUserId, memberUserId, competitionId, teamId } =
          await seedFormingTeamOfPaidCompetition(tx, { withFeeRule: false });

        const { status, body } = await registerTeamViaRoute(
          tx,
          captainUserId,
          competitionId,
          teamId,
        );

        expect(status).toBe(409);
        expect(body).toEqual({
          error: {
            code: "registration_payment_unavailable",
            message: "Kompetisi ini belum dapat menerima pembayaran. Hubungi penyelenggara.",
          },
        });
        expect(
          await registeredStudentIds(tx, competitionId, [captainUserId, memberUserId]),
        ).toHaveLength(0);
        expect(await teamStatus(tx, teamId)).toBe("forming");
        expect(await paymentsPaidBy(tx, captainUserId)).toHaveLength(0);
      });
    });

    it("registers the team once a fee rule is in force", async () => {
      await inRollback(async (tx) => {
        const { captainUserId, memberUserId, competitionId, teamId } =
          await seedFormingTeamOfPaidCompetition(tx, { withFeeRule: true });

        const { status } = await registerTeamViaRoute(tx, captainUserId, competitionId, teamId);

        expect(status).toBe(201);
        expect(await teamStatus(tx, teamId)).toBe("submitted");
        const studentIds = await registeredStudentIds(tx, competitionId, [
          captainUserId,
          memberUserId,
        ]);
        expect([...studentIds].sort()).toEqual([captainUserId, memberUserId].sort());
        expect(await paymentsPaidBy(tx, captainUserId)).toHaveLength(1);
      });
    });
  },
);
