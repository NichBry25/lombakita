// @vitest-environment node
//
// WHAT THE PAYMENT VIEW SAYS ABOUT THE VIEWER'S OWN REGISTRATION, run against a real Postgres.
//
// The payment status is about the money and cannot say who ended the registration, so the view
// carries the person's own registration status and cancellation reason beside it. These tests call
// `loadCandidatePaymentView` the way the candidate page does. The payment and its snapshot are made
// by the real service, and the withdrawal state is the one the bug report describes: a registration
// withdrawn, then a new registration for the same competition.
//
// Every test runs inside a transaction that is ALWAYS rolled back, so nothing here is committed.

import { afterAll, describe, expect, it } from "vitest";
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
  users,
} from "@/server/db/schema";

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

type Fixture = {
  payerUserId: string;
  institutionId: string;
  competitionId: string;
  registrationId: string;
};

/** A verified institution with a bank account and no QRIS, one competition, one registration. */
const seedFixture = async (tx: Tx): Promise<Fixture> => {
  const id = uniqueSuffix();

  const [user] = await tx
    .insert(users)
    .values({
      email: `viewreg_${id}@example.test`,
      username: `viewreg_${id}`,
      candidateVerifiedAt: NOW,
    })
    .returning({ id: users.id });

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `viewreg-inst-${id}`,
      displayName: `View Registration Fixture ${id}`,
      institutionType: "personal",
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `viewreg-comp-${id}`,
      title: `View registration fixture ${id}`,
    })
    .returning({ id: competitions.id });

  const [registration] = await tx
    .insert(competitionRegistrations)
    .values({
      competitionId: competition!.id,
      studentId: user!.id,
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

  await tx.insert(institutionPaymentInstructions).values({
    institutionId: institution!.id,
    bankName: "Bank Contoh",
    accountNumber: "1234567890",
    accountHolderName: "Panitia Lomba",
  });

  return {
    payerUserId: user!.id,
    institutionId: institution!.id,
    competitionId: competition!.id,
    registrationId: registration!.id,
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
        competitionRegistrationId: fixture.registrationId,
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

const loadView = async (tx: Tx, registrationId: string, userId: string) => {
  const { loadCandidatePaymentView } = await import("@/server/finance/candidate-payment-view");
  return loadCandidatePaymentView(registrationId, userId, tx as never);
};

describe.skipIf(skipWithoutDatabase)(
  "the payment view carries the viewer's own registration (real database)",
  () => {
    it("reports a live registration as confirmed with no cancellation reason", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        await createPaymentFor(tx, fixture);

        const view = await loadView(tx, fixture.registrationId, fixture.payerUserId);

        expect(view?.registrationStatus).toBe("confirmed");
        expect(view?.registrationCancellationReason).toBeNull();
      });
    });

    it("reports the withdrawal of the registration that was asked about, not the one that replaced it", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        await createPaymentFor(tx, fixture);
        await tx
          .update(competitionRegistrations)
          .set({
            status: "cancelled",
            cancelledAt: NOW,
            cancellationReason: "Saya berhalangan hadir",
          })
          .where(eq(competitionRegistrations.id, fixture.registrationId));
        await tx.insert(competitionRegistrations).values({
          competitionId: fixture.competitionId,
          studentId: fixture.payerUserId,
          registrationType: "individual",
        });

        const view = await loadView(tx, fixture.registrationId, fixture.payerUserId);

        expect(view?.registrationStatus).toBe("cancelled");
        expect(view?.registrationCancellationReason).toBe("Saya berhalangan hadir");
      });
    });
  },
);
