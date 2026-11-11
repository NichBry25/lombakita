// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  financeFeeRules,
  institutionPaymentInstructions,
  institutions,
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
      throw new Error("the registration route read the database outside a test");
    },
  };
});

vi.mock("@/server/auth/session", () => ({
  requireSessionRole: async () => {
    if (!routeState.actorUserId)
      throw new Error("the registration route ran with no session staged");
    return { user: { id: routeState.actorUserId, role: "candidate" } };
  },
}));

import { POST } from "@/app/api/v1/competitions/[competitionId]/registrations/route";

beforeAll(() => {
  routeState.testRunStarted = true;
});

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

const seedPaidCompetition = async (
  tx: Tx,
  { withFeeRule }: { withFeeRule: boolean },
): Promise<{ candidateUserId: string; competitionId: string }> => {
  const id = uniqueSuffix();
  const now = Date.now();

  const [candidate] = await tx
    .insert(users)
    .values({
      email: `pay_refusal_${id}@example.test`,
      username: `pay_refusal_${id}`,
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `pay-refusal-inst-${id}`,
      institutionType: "personal",
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
      currency: "IDR",
      basisPoints: 250,
      flatAmount: 0,
      effectiveFrom: new Date(now - 30 * DAY_MS),
    });
  }

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `pay-refusal-comp-${id}`,
      title: `Pay Refusal ${id}`,
      status: "published",
      mode: "individual",
      registrationEndAt: new Date(now + 30 * DAY_MS),
      feeAmount: 150_000,
      feeCurrency: "IDR",
      paymentWindowDays: 3,
    })
    .returning({ id: competitions.id });

  return { candidateUserId: candidate!.id, competitionId: competition!.id };
};

const registerViaRoute = async (
  tx: Tx,
  candidateUserId: string,
  competitionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = candidateUserId;

  const response = await POST(
    new Request(`https://lombakita.test/api/v1/competitions/${competitionId}/registrations`, {
      method: "POST",
    }),
    { params: Promise.resolve({ competitionId }) },
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
};

const registrationsFor = async (tx: Tx, candidateUserId: string) =>
  tx
    .select({ id: competitionRegistrations.id })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.studentId, candidateUserId));

describe.skipIf(skipWithoutDatabase)(
  "registering for a priced competition through the route, against a real database",
  () => {
    beforeEach(() => {
      routeState.transaction = null;
      routeState.actorUserId = null;
    });

    it("answers 409 and registers nobody when no fee rule is in force", async () => {
      await inRollback(async (tx) => {
        const { candidateUserId, competitionId } = await seedPaidCompetition(tx, {
          withFeeRule: false,
        });

        const { status, body } = await registerViaRoute(tx, candidateUserId, competitionId);

        expect(status).toBe(409);
        expect(body).toMatchObject({ error: { code: "registration_payment_unavailable" } });
        expect(await registrationsFor(tx, candidateUserId)).toHaveLength(0);
      });
    });

    it("registers once a fee rule is in force", async () => {
      await inRollback(async (tx) => {
        const { candidateUserId, competitionId } = await seedPaidCompetition(tx, {
          withFeeRule: true,
        });

        const { status } = await registerViaRoute(tx, candidateUserId, competitionId);

        expect(status).toBe(201);
        expect(await registrationsFor(tx, candidateUserId)).toHaveLength(1);
      });
    });
  },
);
