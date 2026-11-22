// @vitest-environment node
//
// WHO IS HANDED THE ORGANISER'S QRIS, run against a real Postgres.
//
// `loadCandidatePaymentView` is the only place that decides whether a signed QRIS link exists, so
// these tests call it the way the candidate page does and read what it returns. The competition and
// registrations are seeded rows, and the payment (with its instruction snapshot) and every proof are
// made by the real services. A mocked view or a hand-built view value would prove the panel and not
// the gate.
//
// Storage is the one seam: this run has no R2, so the client module is replaced with a signer that
// records its arguments and returns a fixed link that does not contain the key.
//
// Every test runs inside a transaction that is ALWAYS rolled back, so nothing here is committed.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  competitionRegistrations,
  competitions,
  financeFeeRules,
  institutionPaymentInstructions,
  institutions,
  teams,
  users,
} from "@/server/db/schema";

const {
  mockEnqueuePaymentProofSubmitted,
  mockEnqueuePaymentOutcome,
  mockHeadObject,
  mockDeleteObject,
  mockIsR2Available,
  mockGeneratePresignedGetUrl,
} = vi.hoisted(() => ({
  mockEnqueuePaymentProofSubmitted: vi.fn(),
  mockEnqueuePaymentOutcome: vi.fn(),
  mockHeadObject: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockIsR2Available: vi.fn(),
  mockGeneratePresignedGetUrl: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  enqueuePaymentProofSubmitted: mockEnqueuePaymentProofSubmitted,
  enqueuePaymentOutcome: mockEnqueuePaymentOutcome,
}));

vi.mock("@/server/storage/r2.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/storage/r2.client")>()),
  headObject: mockHeadObject,
  deleteObject: mockDeleteObject,
  isR2Available: mockIsR2Available,
  generatePresignedGetUrl: mockGeneratePresignedGetUrl,
}));

const FAKE_LINK = "https://storage.example.test/qris-link-for-this-load";

beforeEach(() => {
  mockEnqueuePaymentProofSubmitted.mockReset();
  mockEnqueuePaymentOutcome.mockReset();
  mockHeadObject.mockReset();
  mockHeadObject.mockResolvedValue({ sizeBytes: 2048, contentType: "image/jpeg" });
  mockDeleteObject.mockReset();
  mockDeleteObject.mockResolvedValue(undefined);
  mockIsR2Available.mockReset();
  mockIsR2Available.mockReturnValue(true);
  mockGeneratePresignedGetUrl.mockReset();
  mockGeneratePresignedGetUrl.mockResolvedValue(FAKE_LINK);
});

const NOW = new Date("2026-08-10T00:00:00.000Z");
const LAST_MONTH = new Date("2026-07-01T00:00:00.000Z");
const DUE = new Date("2026-08-13T00:00:00.000Z");

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

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
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

const seedUser = async (tx: Tx, label: string): Promise<string> => {
  const id = uniqueSuffix();
  const [user] = await tx
    .insert(users)
    .values({
      email: `${label}_${id}@example.test`,
      username: `${label}_${id}`,
      candidateVerifiedAt: NOW,
    })
    .returning({ id: users.id });
  return user!.id;
};

const seedOperatorAccount = async (tx: Tx): Promise<string> => {
  const id = uniqueSuffix();
  const [operator] = await tx
    .insert(users)
    .values({
      email: `platform_ops_${id}@example.test`,
      username: `platform_ops_${id}`,
      role: "platform_ops",
      candidateVerifiedAt: NOW,
    })
    .returning({ id: users.id });
  return operator!.id;
};

type Fixture = {
  payerUserId: string;
  institutionId: string;
  competitionId: string;
  payerRegistrationId: string;
  platformOpsUserId: string;
  qrisR2Key: string;
};

/**
 * A verified institution that has published a bank account and a QRIS of its own, one competition,
 * and one registered candidate.
 */
const seedFixture = async (
  tx: Tx,
  options: { qrisKeyOf?: (institutionId: string) => string | null } = {},
): Promise<Fixture> => {
  const id = uniqueSuffix();
  const payerUserId = await seedUser(tx, "qrispayer");

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `qris-inst-${id}`,
      institutionType: "personal",
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });
  const institutionId = institution!.id;

  const [competition] = await tx
    .insert(competitions)
    .values({ institutionId, slug: `qris-comp-${id}`, title: `QRIS fixture ${id}` })
    .returning({ id: competitions.id });

  const [registration] = await tx
    .insert(competitionRegistrations)
    .values({
      competitionId: competition!.id,
      studentId: payerUserId,
      registrationType: "individual",
    })
    .returning({ id: competitionRegistrations.id });

  await tx.insert(financeFeeRules).values({
    institutionId: null,
    currency: "IDR",
    basisPoints: 250,
    flatAmount: 0,
    effectiveFrom: LAST_MONTH,
  });

  const qrisKeyOf =
    options.qrisKeyOf ?? ((owner: string) => `payment-instructions/${owner}/qris-${id}`);
  const qrisR2Key = qrisKeyOf(institutionId);
  await tx.insert(institutionPaymentInstructions).values({
    institutionId,
    bankName: "Bank Contoh",
    accountNumber: "1234567890",
    accountHolderName: "Panitia Lomba",
    qrisR2Key,
  });

  return {
    payerUserId,
    institutionId,
    competitionId: competition!.id,
    payerRegistrationId: registration!.id,
    platformOpsUserId: await seedOperatorAccount(tx),
    qrisR2Key: qrisR2Key ?? "",
  };
};

/** The payment, made by the real service, which also writes the instruction snapshot. */
const createPaymentFor = async (tx: Tx, fixture: Fixture): Promise<string> => {
  const { createPayment } = await import("@/server/finance/payment-service");
  const payment = await createPayment(
    {
      payerUserId: fixture.payerUserId,
      receivingInstitutionId: fixture.institutionId,
      origin: "manual_transfer",
      subject: {
        type: "competition_registration",
        competitionRegistrationId: fixture.payerRegistrationId,
      },
      grossAmount: 1_000_000,
      currency: "IDR",
      pricedAt: NOW,
      dueAt: DUE,
    },
    tx as never,
  );
  return payment.id;
};

const submitProofFor = async (tx: Tx, fixture: Fixture, paymentId: string): Promise<string> => {
  const { submitManualPaymentProof } =
    await import("@/server/finance/manual-payment-proof-service");
  const proof = await submitManualPaymentProof(
    {
      paymentId,
      submittedByUserId: fixture.payerUserId,
      r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
      originalFileName: "bukti.jpg",
    },
    tx as never,
  );
  return proof.id;
};

const rejectProof = async (
  tx: Tx,
  fixture: Fixture,
  proofId: string,
  resubmissionAllowed: boolean,
): Promise<void> => {
  const { rejectManualPaymentProof } =
    await import("@/server/finance/manual-payment-proof-service");
  await rejectManualPaymentProof(
    fixture.institutionId,
    fixture.payerUserId,
    proofId,
    "bukti tidak terbaca",
    resubmissionAllowed,
    tx as never,
    NOW,
  );
};

/** The payer's registration becomes a team of two, and the second member is not the payer. */
const addTeammate = async (tx: Tx, fixture: Fixture) => {
  const [team] = await tx
    .insert(teams)
    .values({
      competitionId: fixture.competitionId,
      captainId: fixture.payerUserId,
      name: `Tim ${uniqueSuffix()}`,
      status: "submitted",
    })
    .returning({ id: teams.id });

  await tx
    .update(competitionRegistrations)
    .set({ registrationType: "team", teamId: team!.id })
    .where(eq(competitionRegistrations.id, fixture.payerRegistrationId));

  const teammateUserId = await seedUser(tx, "qristeammate");
  const [teammateRegistration] = await tx
    .insert(competitionRegistrations)
    .values({
      competitionId: fixture.competitionId,
      studentId: teammateUserId,
      registrationType: "team",
      teamId: team!.id,
    })
    .returning({ id: competitionRegistrations.id });

  return { teammateUserId, teammateRegistrationId: teammateRegistration!.id };
};

const loadView = async (tx: Tx, registrationId: string, userId: string) => {
  const { loadCandidatePaymentView } = await import("@/server/finance/candidate-payment-view");
  return loadCandidatePaymentView(registrationId, userId, tx as never);
};

describe.skipIf(skipWithoutDatabase)("who is handed the organiser's QRIS (real database)", () => {
  it("shows the link to the payer who can still send a proof, signed for the snapshot's own key", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await createPaymentFor(tx, fixture);

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.canSubmitProof).toBe(true);
      expect(view?.instructions?.qris).toEqual({ kind: "shown", url: FAKE_LINK });
      expect(mockGeneratePresignedGetUrl).toHaveBeenCalledTimes(1);
      expect(mockGeneratePresignedGetUrl).toHaveBeenCalledWith(fixture.qrisR2Key, 3600, {
        responseContentType: "image/png",
        responseContentDisposition: 'inline; filename="qris.png"',
      });
      expect(JSON.stringify(view)).not.toContain(fixture.qrisR2Key);
    });
  });

  it("hides it from a teammate who is not the payer, and signs nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await createPaymentFor(tx, fixture);
      const teammate = await addTeammate(tx, fixture);

      const view = await loadView(tx, teammate.teammateRegistrationId, teammate.teammateUserId);

      expect(view?.isPayer).toBe(false);
      expect(view?.instructions?.qris).toEqual({ kind: "hidden" });
      expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
      expect(JSON.stringify(view)).not.toContain(fixture.qrisR2Key);
      expect(JSON.stringify(view)).not.toContain(FAKE_LINK);
    });
  });

  it("hides it from a payer whose proof is waiting for review, and signs nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await createPaymentFor(tx, fixture);
      await submitProofFor(tx, fixture, paymentId);

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.proof?.status).toBe("pending_review");
      expect(view?.instructions?.qris).toEqual({ kind: "hidden" });
      expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
    });
  });

  it("hides it from a payer whose rejected proof cannot be resent, and signs nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await createPaymentFor(tx, fixture);
      const proofId = await submitProofFor(tx, fixture, paymentId);
      await rejectProof(tx, fixture, proofId, false);

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.canSubmitProof).toBe(false);
      expect(view?.canResubmitProof).toBe(false);
      expect(view?.instructions?.qris).toEqual({ kind: "hidden" });
      expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
    });
  });

  it("shows it to a payer whose rejected proof may be resent", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await createPaymentFor(tx, fixture);
      const proofId = await submitProofFor(tx, fixture, paymentId);
      await rejectProof(tx, fixture, proofId, true);

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.canResubmitProof).toBe(true);
      expect(view?.instructions?.qris).toEqual({ kind: "shown", url: FAKE_LINK });
    });
  });

  it("shows it to a payer whose proof was voided", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await createPaymentFor(tx, fixture);
      const proofId = await submitProofFor(tx, fixture, paymentId);
      await rejectProof(tx, fixture, proofId, false);
      const { voidManualPaymentProof } =
        await import("@/server/finance/manual-payment-proof-service");
      await voidManualPaymentProof(
        fixture.platformOpsUserId,
        proofId,
        "bukti sah dikirim ke dukungan",
        tx as never,
        NOW,
      );

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.proof?.status).toBe("voided");
      expect(view?.canResubmitProof).toBe(true);
      expect(view?.instructions?.qris).toEqual({ kind: "shown", url: FAKE_LINK });
    });
  });

  it("hides it once the payer's registration is cancelled, because the lane is closed", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await createPaymentFor(tx, fixture);
      await tx
        .update(competitionRegistrations)
        .set({ status: "cancelled" })
        .where(eq(competitionRegistrations.id, fixture.payerRegistrationId));

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.canSubmitProof).toBe(false);
      expect(view?.instructions?.qris).toEqual({ kind: "hidden" });
      expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
    });
  });

  it("signs the QRIS the payer was snapshotted, not the institution's current one", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await createPaymentFor(tx, fixture);
      const replacementKey = `payment-instructions/${fixture.institutionId}/replacement-${uniqueSuffix()}`;
      await tx
        .update(institutionPaymentInstructions)
        .set({ qrisR2Key: replacementKey })
        .where(eq(institutionPaymentInstructions.institutionId, fixture.institutionId));

      await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(mockGeneratePresignedGetUrl).toHaveBeenCalledTimes(1);
      expect(mockGeneratePresignedGetUrl.mock.calls[0]![0]).toBe(fixture.qrisR2Key);
    });
  });

  it("reports no QRIS, and signs nothing, when the snapshot holds none", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx, { qrisKeyOf: () => null });
      await createPaymentFor(tx, fixture);

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.instructions?.qris).toEqual({ kind: "none" });
      expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
    });
  });

  it("returns unavailable and does not throw when the snapshot's key belongs to another institution", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx, {
        qrisKeyOf: () => `payment-instructions/some-other-institution/qris-${uniqueSuffix()}`,
      });
      await createPaymentFor(tx, fixture);

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.canSubmitProof).toBe(true);
      expect(view?.instructions?.qris).toEqual({ kind: "unavailable" });
      expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
    });
  });

  it("returns unavailable and does not throw when storage is not configured", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await createPaymentFor(tx, fixture);
      mockIsR2Available.mockReturnValue(false);

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.canSubmitProof).toBe(true);
      expect(view?.instructions?.qris).toEqual({ kind: "unavailable" });
      expect(mockGeneratePresignedGetUrl).not.toHaveBeenCalled();
    });
  });

  it("returns unavailable and does not throw when signing itself fails", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await createPaymentFor(tx, fixture);
      mockGeneratePresignedGetUrl.mockRejectedValue(new Error("R2_BUCKET is not configured"));

      const view = await loadView(tx, fixture.payerRegistrationId, fixture.payerUserId);

      expect(view?.instructions?.qris).toEqual({ kind: "unavailable" });
    });
  });
});
