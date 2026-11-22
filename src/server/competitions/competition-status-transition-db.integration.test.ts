// @vitest-environment node
//
// Published to draft is a move of the state machine, and transitionCompetitionStatus writes only the
// status. It must not write it: unpublishing cancels every registration and refuses while a transfer
// proof is in flight, and only unpublishCompetition does both. The proof is on the stored state
// after the call, not on the refusal alone, because a refusal thrown after the status write has
// already committed draft.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  financeFeeRules,
  financePayments,
  institutionMemberships,
  institutionPaymentInstructions,
  institutions,
  users,
} from "@/server/db/schema";
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
  enqueueRegistrationConfirmed: vi.fn(async () => ({})),
  enqueuePaymentProofSubmitted: vi.fn(async () => ({})),
  enqueueCompetitionSearchSync: vi.fn(async () => ({})),
}));

vi.mock("@/server/storage/r2.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/storage/r2.client")>()),
  headObject: vi.fn(async () => ({ sizeBytes: 2048, contentType: "image/jpeg" })),
  deleteObject: vi.fn(async () => undefined),
}));

import { transitionCompetitionStatus } from "@/server/competitions/competition-service";
import { submitManualPaymentProof } from "@/server/finance/manual-payment-proof-service";
import { createIndividualRegistration } from "@/server/registrations/registration-service";

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

const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

type Seed = { ownerId: string; competitionId: string };

const seedUser = async (
  tx: Tx,
  label: string,
  values: Partial<typeof users.$inferInsert>,
): Promise<string> => {
  const username = `transition_${label}_${uniqueSuffix()}`;
  const [row] = await tx
    .insert(users)
    .values({
      email: `${username}@example.test`,
      username,
      emailVerified: new Date(),
      candidateVerifiedAt: new Date(),
      ...values,
    })
    .returning({ id: users.id });
  return row!.id;
};

/** A priced competition of a verified institution that can take payment, in the status asked for. */
const seedPricedCompetition = async (tx: Tx, status: "draft" | "published"): Promise<Seed> => {
  const suffix = uniqueSuffix();
  const ownerId = await seedUser(tx, "owner", {
    role: "recruiter",
    recruiterVerifiedAt: new Date(),
    recruiterVerificationTier: "elevated",
  });

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `transition-inst-${suffix}`,
      institutionType: "company",
      displayName: `Transition ${suffix}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: ownerId,
    membershipRole: "institution_owner",
    status: "active",
  });

  await tx.insert(institutionPaymentInstructions).values({
    institutionId: institution!.id,
    bankName: "Bank Contoh",
    accountNumber: "1234567890",
    accountHolderName: "Panitia Lomba",
  });

  await tx.insert(financeFeeRules).values({
    institutionId: institution!.id,
    currency: "IDR",
    basisPoints: 250,
    flatAmount: 0,
    effectiveFrom: new Date(Date.now() - 30 * DAY_MS),
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `transition-comp-${suffix}`,
      title: `Kompetisi ${suffix}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "individual",
      location: "online",
      audience: ["umum"],
      status,
      registrationStartAt: new Date(Date.now() - 7 * DAY_MS),
      registrationEndAt: new Date(Date.now() + 14 * DAY_MS),
      participantConfirmationAt: new Date(Date.now() + 20 * DAY_MS),
      eventStartAt: new Date(Date.now() + 30 * DAY_MS),
      eventEndAt: new Date(Date.now() + 31 * DAY_MS),
      resultAnnouncementAt: new Date(Date.now() + 40 * DAY_MS),
      allowCancellation: true,
      cancellationCutoffDays: 1,
      organizerContactKind: "whatsapp",
      organizerContactValue: "628123456789",
      feeAmount: 150_000,
      feeCurrency: "IDR",
      paymentWindowDays: 3,
    })
    .returning({ id: competitions.id });

  return { ownerId, competitionId: competition!.id };
};

const registerWithProofPendingReview = async (tx: Tx, seed: Seed): Promise<string> => {
  const candidateId = await seedUser(tx, "candidate", {});
  const registration = await createIndividualRegistration(
    candidateId,
    seed.competitionId,
    tx as never,
  );
  const [payment] = await tx
    .select({ id: financePayments.id })
    .from(financePayments)
    .where(eq(financePayments.competitionRegistrationId, registration.id));
  await submitManualPaymentProof(
    {
      paymentId: payment!.id,
      submittedByUserId: candidateId,
      r2Key: `payment-proofs/${seed.competitionId}/${payment!.id}/bukti.jpg`,
      originalFileName: "bukti.jpg",
    },
    tx as never,
  );
  return registration.id;
};

const statusOfCompetition = async (tx: Tx, competitionId: string): Promise<string> => {
  const [row] = await tx
    .select({ status: competitions.status })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row!.status;
};

const statusOfRegistration = async (tx: Tx, registrationId: string): Promise<string> => {
  const [row] = await tx
    .select({ status: competitionRegistrations.status })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.id, registrationId));
  return row!.status;
};

type Refusal = { code: string; status: number } | null;

const refusalOf = async (work: Promise<unknown>): Promise<Refusal> => {
  try {
    await work;
    return null;
  } catch (error) {
    const coded = error as { code?: unknown; httpStatus?: unknown };
    if (typeof coded.code !== "string" || typeof coded.httpStatus !== "number") throw error;
    return { code: coded.code, status: coded.httpStatus };
  }
};

describe.skipIf(skipWithoutDatabase)("transitionCompetitionStatus, published to draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses with a proof pending review, and the competition stays published with its registration", async () => {
    await inRollback(async (tx) => {
      const seed = await seedPricedCompetition(tx, "published");
      const registrationId = await registerWithProofPendingReview(tx, seed);

      const refusal = await refusalOf(
        transitionCompetitionStatus(seed.ownerId, seed.competitionId, "draft", tx as never),
      );

      expect({
        refusal,
        competitionStatus: await statusOfCompetition(tx, seed.competitionId),
        registrationStatus: await statusOfRegistration(tx, registrationId),
      }).toEqual({
        refusal: { code: "competition_invalid_transition", status: 422 },
        competitionStatus: "published",
        registrationStatus: "confirmed",
      });
    });
  });

  it("refuses with no proof in flight as well, because this primitive never cancels the registrations", async () => {
    await inRollback(async (tx) => {
      const seed = await seedPricedCompetition(tx, "published");

      const refusal = await refusalOf(
        transitionCompetitionStatus(seed.ownerId, seed.competitionId, "draft", tx as never),
      );

      expect({
        refusal,
        competitionStatus: await statusOfCompetition(tx, seed.competitionId),
      }).toEqual({
        refusal: { code: "competition_invalid_transition", status: 422 },
        competitionStatus: "published",
      });
    });
  });

  it("still publishes a draft, so the refusal above is the draft target and not a blanket bar", async () => {
    await inRollback(async (tx) => {
      const seed = await seedPricedCompetition(tx, "draft");

      const result = await transitionCompetitionStatus(
        seed.ownerId,
        seed.competitionId,
        "published",
        tx as never,
      );

      expect(result.competition.status).toBe("published");
      expect(await statusOfCompetition(tx, seed.competitionId)).toBe("published");
    });
  });
});
