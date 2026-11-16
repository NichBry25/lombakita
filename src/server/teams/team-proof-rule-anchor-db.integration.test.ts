// @vitest-environment node

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
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
import {
  cancelTeamRegistration,
  hasFormingTeamSentPaymentProof,
  revertSubmittedTeamToForming,
  submitTeamRegistration,
} from "@/server/teams/team-registration-service";
import { TEAM_BELOW_MINIMUM_CANCELLATION_REASON } from "@/server/teams/team-close-check-service";
import {
  rejectManualPaymentProof,
  submitManualPaymentProof,
  verifyManualPaymentProof,
  voidManualPaymentProof,
} from "@/server/finance/manual-payment-proof-service";

const enqueueSpies = vi.hoisted(() => ({
  enqueueRegistrationConfirmed: vi.fn(),
  enqueueRegistrationCancelled: vi.fn(),
  enqueuePaymentProofSubmitted: vi.fn(),
  enqueuePaymentOutcome: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  ...enqueueSpies,
}));

vi.mock("@/server/storage/r2.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/storage/r2.client")>()),
  headObject: vi.fn(async () => ({ sizeBytes: 2048, contentType: "image/jpeg" })),
  deleteObject: vi.fn(async () => undefined),
}));

beforeEach(() => {
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
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
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

const T0 = new Date("2026-09-01T03:00:00.000Z");
const WITHDRAWN_AT = new Date("2026-09-01T04:00:00.000Z");
const REGISTERED_AGAIN_AT = new Date("2026-09-02T03:00:00.000Z");
const VERIFIED_AT = new Date("2026-09-02T04:00:00.000Z");

const seedUser = async (tx: Tx, label: string, suffix: string): Promise<string> => {
  const [row] = await tx
    .insert(users)
    .values({
      email: `anchor_rule_${label}_${suffix}@example.test`,
      username: `anchor_rule_${label}_${suffix}`,
      candidateVerifiedAt: T0,
    })
    .returning({ id: users.id });
  return row!.id;
};

type PricedTeam = {
  organiserUserId: string;
  captainUserId: string;
  institutionId: string;
  competitionId: string;
  teamId: string;
};

const seedFormingPricedTeam = async (tx: Tx): Promise<PricedTeam> => {
  const suffix = uniqueSuffix();
  const organiserUserId = await seedUser(tx, "organiser", suffix);
  const captainUserId = await seedUser(tx, "captain", suffix);
  const memberUserId = await seedUser(tx, "member", suffix);

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `anchor-rule-inst-${suffix}`,
      institutionType: "company",
      displayName: `Anchor Rule ${suffix}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

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
    effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `anchor-rule-comp-${suffix}`,
      title: `Anchor Rule ${suffix}`,
      status: "published",
      mode: "team",
      minTeamSize: 2,
      maxTeamSize: 4,
      registrationStartAt: new Date("2026-08-25T00:00:00.000Z"),
      registrationEndAt: new Date("2026-10-01T00:00:00.000Z"),
      eventStartAt: new Date("2026-11-01T00:00:00.000Z"),
      allowCancellation: true,
      cancellationCutoffDays: 1,
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
      name: `Tim ${suffix}`,
      status: "forming",
    })
    .returning({ id: teams.id });

  await tx.insert(teamMemberships).values([
    { teamId: team!.id, userId: captainUserId, role: "captain", status: "active" },
    { teamId: team!.id, userId: memberUserId, role: "member", status: "active" },
  ]);

  return {
    organiserUserId,
    captainUserId,
    institutionId: institution!.id,
    competitionId: competition!.id,
    teamId: team!.id,
  };
};

const registerTeam = async (tx: Tx, seed: PricedTeam, at: Date): Promise<string> => {
  const registered = await submitTeamRegistration(
    seed.captainUserId,
    seed.competitionId,
    seed.teamId,
    tx as never,
    at,
  );
  const captainRow = registered.registrations.find((row) => row.studentId === seed.captainUserId);
  const [payment] = await tx
    .select({ id: financePayments.id })
    .from(financePayments)
    .where(eq(financePayments.competitionRegistrationId, captainRow!.id));
  return payment!.id;
};

const sendProof = async (tx: Tx, seed: PricedTeam, paymentId: string): Promise<string> => {
  const proof = await submitManualPaymentProof(
    {
      paymentId,
      submittedByUserId: seed.captainUserId,
      r2Key: `payment-proofs/${seed.competitionId}/${paymentId}/bukti.jpg`,
      originalFileName: "bukti.jpg",
    },
    tx as never,
  );
  return proof.id;
};

const revertToForming = (tx: Tx, seed: PricedTeam) =>
  revertSubmittedTeamToForming(
    tx as never,
    seed.teamId,
    seed.competitionId,
    TEAM_BELOW_MINIMUM_CANCELLATION_REASON,
    WITHDRAWN_AT,
  );

const proofRuleAnswer = (tx: Tx, seed: PricedTeam): Promise<boolean> =>
  hasFormingTeamSentPaymentProof(seed.teamId, seed.competitionId, tx as never);

type ProofVerdict = "pending_review" | "verified" | "rejected" | "voided";

const settleProofAs = async (
  tx: Tx,
  seed: PricedTeam,
  proofId: string,
  verdict: ProofVerdict,
): Promise<void> => {
  if (verdict === "verified") {
    await verifyManualPaymentProof(
      seed.institutionId,
      seed.organiserUserId,
      proofId,
      tx as never,
      VERIFIED_AT,
    );
  }
  if (verdict === "rejected") {
    await rejectManualPaymentProof(
      seed.institutionId,
      seed.organiserUserId,
      proofId,
      "nominal tidak sesuai",
      true,
      tx as never,
      VERIFIED_AT,
    );
  }
  if (verdict === "voided") {
    await voidManualPaymentProof(
      seed.organiserUserId,
      proofId,
      "dibatalkan operator",
      tx as never,
      VERIFIED_AT,
    );
  }
};

const formingAfterCancelWithProof = async (tx: Tx, verdict: ProofVerdict): Promise<boolean> => {
  const seed = await seedFormingPricedTeam(tx);
  const paymentId = await registerTeam(tx, seed, T0);
  const proofId = await sendProof(tx, seed, paymentId);
  await settleProofAs(tx, seed, proofId, verdict);
  await revertToForming(tx, seed);
  return proofRuleAnswer(tx, seed);
};

const cancelAndRegisterAgain = async (tx: Tx, seed: PricedTeam): Promise<string> => {
  await registerTeam(tx, seed, T0);
  await cancelTeamRegistration(
    seed.captainUserId,
    seed.competitionId,
    seed.teamId,
    "berubah rencana",
    tx as never,
    WITHDRAWN_AT,
  );
  return registerTeam(tx, seed, REGISTERED_AGAIN_AT);
};

describe.skipIf(skipWithoutDatabase)(
  "whether a team sent a payment proof, asked of every state a team can be in",
  () => {
    it("answers as recorded for each state", async () => {
      await inRollback(async (tx) => {
        const neverRegistered = await proofRuleAnswer(tx, await seedFormingPricedTeam(tx));

        const cancelledNoProofSeed = await seedFormingPricedTeam(tx);
        await registerTeam(tx, cancelledNoProofSeed, T0);
        await cancelTeamRegistration(
          cancelledNoProofSeed.captainUserId,
          cancelledNoProofSeed.competitionId,
          cancelledNoProofSeed.teamId,
          "berubah rencana",
          tx as never,
          WITHDRAWN_AT,
        );
        const formingAfterCancelNoProof = await proofRuleAnswer(tx, cancelledNoProofSeed);

        const registeredAgainSeed = await seedFormingPricedTeam(tx);
        await cancelAndRegisterAgain(tx, registeredAgainSeed);
        const registeredCancelledRegisteredAgain = await proofRuleAnswer(tx, registeredAgainSeed);

        const registeredAgainProofSeed = await seedFormingPricedTeam(tx);
        const secondPaymentId = await cancelAndRegisterAgain(tx, registeredAgainProofSeed);
        await sendProof(tx, registeredAgainProofSeed, secondPaymentId);
        const registeredCancelledRegisteredAgainWithProof = await proofRuleAnswer(
          tx,
          registeredAgainProofSeed,
        );

        const submittedNoProofSeed = await seedFormingPricedTeam(tx);
        await registerTeam(tx, submittedNoProofSeed, T0);
        const submittedWithoutProof = await proofRuleAnswer(tx, submittedNoProofSeed);

        const submittedProofSeed = await seedFormingPricedTeam(tx);
        const submittedPaymentId = await registerTeam(tx, submittedProofSeed, T0);
        await sendProof(tx, submittedProofSeed, submittedPaymentId);
        const submittedWithProof = await proofRuleAnswer(tx, submittedProofSeed);

        expect({
          neverRegistered,
          formingAfterCancelNoProof,
          formingAfterCancelProofPendingReview: await formingAfterCancelWithProof(
            tx,
            "pending_review",
          ),
          formingAfterCancelProofVerified: await formingAfterCancelWithProof(tx, "verified"),
          formingAfterCancelProofRejected: await formingAfterCancelWithProof(tx, "rejected"),
          formingAfterCancelProofVoided: await formingAfterCancelWithProof(tx, "voided"),
          registeredCancelledRegisteredAgain,
          registeredCancelledRegisteredAgainWithProof,
          submittedWithoutProof,
          submittedWithProof,
        }).toEqual({
          neverRegistered: false,
          formingAfterCancelNoProof: false,
          formingAfterCancelProofPendingReview: true,
          formingAfterCancelProofVerified: true,
          formingAfterCancelProofRejected: true,
          formingAfterCancelProofVoided: true,
          registeredCancelledRegisteredAgain: false,
          registeredCancelledRegisteredAgainWithProof: true,
          submittedWithoutProof: false,
          submittedWithProof: false,
        });
      });
    });
  },
);
