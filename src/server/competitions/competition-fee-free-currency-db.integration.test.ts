// @vitest-environment node
//
// The schema allows a free amount (0 or null) next to a stored currency, and no writer produces
// that row today. Saving it as free must not be refused as a currency change: the fee path stores a
// free fee with no currency, so the stored currency of a free fee is not a price.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { competitions, institutionMemberships, institutions, users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

const serviceState = vi.hoisted(() => ({ testRunStarted: false }));

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (!serviceState.testRunStarted) return actual.getDb();
      throw new Error("a service read the database outside the test's transaction");
    },
  };
});

vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  enqueueCompetitionEdited: vi.fn(async () => ({})),
}));

import { setCompetitionFee } from "@/server/competitions/competition-fee-service";

beforeAll(() => {
  serviceState.testRunStarted = true;
});

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

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const seedPublishedCompetitionWithFreeAmountAndCurrency = async (
  tx: Tx,
  freeAmount: 0 | null,
): Promise<{ ownerUserId: string; competitionId: string }> => {
  const suffix = uniqueSuffix();

  const [owner] = await tx
    .insert(users)
    .values({
      email: `free_currency_${suffix}@example.test`,
      username: `free_currency_${suffix}`,
      role: "recruiter",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    })
    .returning({ id: users.id });

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `free-currency-inst-${suffix}`,
      institutionType: "company",
      displayName: `Free Currency ${suffix}`,
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
      slug: `free-currency-comp-${suffix}`,
      title: `Free Currency ${suffix}`,
      description: "",
      mode: "individual",
      status: "published",
      feeAmount: freeAmount,
      feeCurrency: "IDR",
      paymentWindowDays: 3,
    })
    .returning({ id: competitions.id });

  return { ownerUserId: owner!.id, competitionId: competition!.id };
};

const storedPricing = async (tx: Tx, competitionId: string) => {
  const [row] = await tx
    .select({
      feeAmount: competitions.feeAmount,
      feeCurrency: competitions.feeCurrency,
      paymentWindowDays: competitions.paymentWindowDays,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row!;
};

describe.skipIf(skipWithoutDatabase)("saving a free fee over a stored currency", () => {
  it.each([
    ["a zero amount", 0 as const],
    ["a null amount", null],
  ])(
    "saves free with a window change over %s and 'IDR', and stores no amount and no currency",
    async (_label, freeAmount) => {
      await inRollback(async (tx) => {
        const { ownerUserId, competitionId } =
          await seedPublishedCompetitionWithFreeAmountAndCurrency(tx, freeAmount);

        await setCompetitionFee(
          ownerUserId,
          competitionId,
          { feeAmount: null, feeCurrency: null, paymentWindowDays: 5 },
          tx as never,
        );

        expect(await storedPricing(tx, competitionId)).toEqual({
          feeAmount: null,
          feeCurrency: null,
          paymentWindowDays: 5,
        });
      });
    },
  );
});
