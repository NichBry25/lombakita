// @vitest-environment node
//
// The manual lane's guards, run against a real Postgres.
//
// Every rule asserted here is enforced by a CHECK, a partial unique index or a NOT NULL, which
// means the mocked unit suite structurally cannot test them: removing a constraint from schema.ts
// leaves every mocked test green. Each test is written so that DELETING ITS GUARD makes it fail —
// an insert that should be refused would simply succeed.
//
// Also covered here, because they are equally invisible to a mocked database:
//   - the DEC-0158 charging gate at the payment-creation site, including a GUARD-REMOVAL PROOF
//   - the two paid predicates, which fold real event streams over real payment groups
//   - the payment group across a real team registration (N rows, one payment)
//
// Every test runs inside a transaction that is ALWAYS rolled back, so the dev database is left
// byte-identical. Nothing here is committed.

import { afterAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, and, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  competitionRegistrations,
  competitions,
  financeFeeAccruals,
  financeFeeRules,
  financeManualPaymentProofs,
  financePayments,
  institutionPaymentInstructions,
  institutions,
  teams,
  users,
} from "@/server/db/schema";

const DATABASE_URL = TEST_DATABASE_URL;

const NOW = new Date("2026-08-10T00:00:00.000Z");
const LAST_MONTH = new Date("2026-07-01T00:00:00.000Z");
const DUE = new Date("2026-08-13T00:00:00.000Z");

const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
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

/** Runs `body` in a SAVEPOINT and returns the SQLSTATE plus constraint Postgres refused it with. */
const expectRejection = async (
  tx: Tx,
  body: (tx: Tx) => Promise<unknown>,
): Promise<{ code: string; constraint: string }> => {
  try {
    await tx.transaction(async (nested) => {
      await body(nested);
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const e = current as {
        code?: string;
        constraint_name?: string;
        constraint?: string;
        cause?: unknown;
      };
      if (typeof e.code === "string") {
        return { code: e.code, constraint: e.constraint_name ?? e.constraint ?? "" };
      }
      current = e.cause;
    }
    throw error;
  }
  throw new Error("expected the database to refuse this row, but it was accepted");
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

type Fixture = {
  userId: string;
  institutionId: string;
  unverifiedInstitutionId: string;
  competitionId: string;
  registrationId: string;
  feeRuleId: string;
};

const seedFixture = async (tx: Tx): Promise<Fixture> => {
  const id = uniqueSuffix();

  const [user] = await tx
    .insert(users)
    .values({
      email: `manual_${id}@example.test`,
      username: `manual_${id}`,
      // users_one_verified_role_chk requires at least one verified role.
      candidateVerifiedAt: NOW,
    })
    .returning({ id: users.id });

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `manual-inst-${id}`,
      institutionType: "personal",
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  const [unverified] = await tx
    .insert(institutions)
    .values({ slug: `manual-unver-${id}`, institutionType: "personal" })
    .returning({ id: institutions.id });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `manual-comp-${id}`,
      title: `Manual fixture ${id}`,
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

  const [feeRule] = await tx
    .insert(financeFeeRules)
    .values({
      institutionId: null,
      currency: "IDR",
      basisPoints: 250,
      flatAmount: 0,
      effectiveFrom: LAST_MONTH,
    })
    .returning({ id: financeFeeRules.id });

  return {
    userId: user!.id,
    institutionId: institution!.id,
    unverifiedInstitutionId: unverified!.id,
    competitionId: competition!.id,
    registrationId: registration!.id,
    feeRuleId: feeRule!.id,
  };
};

/** A manual-lane payment row: fee 0, net = gross, carrying its deadline. */
const manualPaymentValues = (fixture: Fixture, overrides: Record<string, unknown> = {}) => ({
  payerUserId: fixture.userId,
  receivingInstitutionId: fixture.institutionId,
  origin: "manual_transfer" as const,
  subjectType: "competition_registration" as const,
  competitionRegistrationId: fixture.registrationId,
  currency: "IDR",
  grossAmount: 1_000_000,
  feeRuleId: fixture.feeRuleId,
  feeBasisPoints: 250,
  feeFlatAmount: 0,
  platformFeeAmount: 0,
  institutionNetAmount: 1_000_000,
  dueAt: DUE,
  ...overrides,
});

const seedManualPayment = async (
  tx: Tx,
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const [payment] = await tx
    .insert(financePayments)
    .values(manualPaymentValues(fixture, overrides))
    .returning({ id: financePayments.id });
  return payment!.id;
};

const accrualValues = (
  fixture: Fixture,
  paymentId: string,
  overrides: Record<string, unknown> = {},
) => ({
  paymentId,
  owingInstitutionId: fixture.institutionId,
  entryType: "accrued" as const,
  currency: "IDR",
  amount: 25_000,
  feeRuleId: fixture.feeRuleId,
  feeBasisPoints: 250,
  feeFlatAmount: 0,
  grossAmount: 1_000_000,
  ...overrides,
});

describe.skipIf(skipWithoutDatabase)("finance_payments origin + manual lane (real database)", () => {
  it("refuses a manual payment that records a platform fee — nothing splits on this lane", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financePayments).values(
          manualPaymentValues(fixture, {
            platformFeeAmount: 25_000,
            institutionNetAmount: 975_000,
          }),
        ),
      );

      expect(rejection.constraint).toBe("finance_payments_manual_lane_no_split_chk");
    });
  });

  it("refuses a manual payment with no due date — it would never lapse", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financePayments).values(manualPaymentValues(fixture, { dueAt: null })),
      );

      expect(rejection.constraint).toBe("finance_payments_manual_due_at_chk");
    });
  });

  it("accepts a gateway payment that DOES split, so the CHECK is lane-specific", async () => {
    // Without this the previous two tests would also pass against a CHECK that simply forbade any
    // split at all, which would break the gateway lane.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const [payment] = await tx
        .insert(financePayments)
        .values(
          manualPaymentValues(fixture, {
            origin: "gateway",
            platformFeeAmount: 25_000,
            institutionNetAmount: 975_000,
            dueAt: null,
          }),
        )
        .returning({ id: financePayments.id });

      expect(payment?.id).toBeTruthy();
    });
  });

  it("requires origin — there is no default to fall back on", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const values = manualPaymentValues(fixture) as Record<string, unknown>;
      delete values.origin;

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financePayments).values(values as never),
      );

      // 23502 = not_null_violation.
      expect(rejection.code).toBe("23502");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("finance_fee_accruals (real database)", () => {
  it("permits exactly ONE accrued row per payment", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await tx.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId));

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId)),
      );

      // 23505 = unique_violation. This is the guarantee a service read-then-write cannot make.
      expect(rejection.code).toBe("23505");
      expect(rejection.constraint).toBe("finance_fee_accruals_payment_accrued_unique_idx");
    });
  });

  it("leaves compensating rows UNCONSTRAINED — a fee can be corrected more than once", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await tx.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId));

      for (const reason of ["proof was invalid", "restated after review"]) {
        await tx
          .insert(financeFeeAccruals)
          .values(
            accrualValues(fixture, paymentId, {
              entryType: "reversed",
              amount: -25_000,
              reason,
            }),
          );
      }

      const rows = await tx
        .select({ id: financeFeeAccruals.id })
        .from(financeFeeAccruals)
        .where(eq(financeFeeAccruals.paymentId, paymentId));

      expect(rows).toHaveLength(3);
    });
  });

  it("refuses a reversal with no reason", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .insert(financeFeeAccruals)
          .values(
            accrualValues(fixture, paymentId, { entryType: "reversed", amount: -25_000 }),
          ),
      );

      expect(rejection.constraint).toBe("finance_fee_accruals_reason_required_chk");
    });
  });

  it("ties the sign of the amount to the entry type", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const negativeAccrual = await expectRejection(tx, (nested) =>
        nested.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId, { amount: -1 })),
      );
      expect(negativeAccrual.constraint).toBe("finance_fee_accruals_amount_sign_chk");

      const positiveReversal = await expectRejection(tx, (nested) =>
        nested.insert(financeFeeAccruals).values(
          accrualValues(fixture, paymentId, {
            entryType: "reversed",
            amount: 1,
            reason: "wrong direction",
          }),
        ),
      );
      expect(positiveReversal.constraint).toBe("finance_fee_accruals_amount_sign_chk");
    });
  });

  it("refuses to orphan an accrual — the payment foreign key has no cascade", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      await tx.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId));

      const rejection = await expectRejection(tx, (nested) =>
        nested.delete(financePayments).where(eq(financePayments.id, paymentId)),
      );

      // 23503 = foreign_key_violation.
      expect(rejection.code).toBe("23503");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("finance_manual_payment_proofs (real database)", () => {
  const proofValues = (
    fixture: Fixture,
    paymentId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    paymentId,
    competitionId: fixture.competitionId,
    submittedByUserId: fixture.userId,
    status: "pending_review" as const,
    r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/file`,
    originalFileName: "bukti.jpg",
    fileSizeBytes: 1024,
    contentType: "image/jpeg",
    ...overrides,
  });

  it("permits only ONE proof per payment", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await tx.insert(financeManualPaymentProofs).values(proofValues(fixture, paymentId));

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financeManualPaymentProofs).values(proofValues(fixture, paymentId)),
      );

      expect(rejection.code).toBe("23505");
      expect(rejection.constraint).toBe("finance_manual_payment_proofs_payment_unique_idx");
    });
  });

  it("refuses a rejected proof with no reason — the candidate would not know what to fix", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .insert(financeManualPaymentProofs)
          .values(proofValues(fixture, paymentId, { status: "rejected", reviewedAt: NOW })),
      );

      expect(rejection.constraint).toBe("finance_manual_payment_proofs_rejection_reason_chk");
    });
  });

  it("refuses a reviewed status with no reviewed_at", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .insert(financeManualPaymentProofs)
          .values(proofValues(fixture, paymentId, { status: "verified" })),
      );

      expect(rejection.constraint).toBe("finance_manual_payment_proofs_reviewed_chk");
    });
  });

  it("refuses a zero-byte file", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .insert(financeManualPaymentProofs)
          .values(proofValues(fixture, paymentId, { fileSizeBytes: 0 })),
      );

      expect(rejection.constraint).toBe("finance_manual_payment_proofs_file_size_chk");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("institution_payment_instructions (real database)", () => {
  it("refuses a row that names neither a bank account nor a QRIS", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .insert(institutionPaymentInstructions)
          .values({ institutionId: fixture.institutionId, instructionsNote: "transfer ya" }),
      );

      expect(rejection.constraint).toBe("institution_payment_instructions_payable_chk");
    });
  });

  it("refuses a partial bank account — all three parts are needed to be payable", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(institutionPaymentInstructions).values({
          institutionId: fixture.institutionId,
          bankName: "BCA",
          accountNumber: "1234567890",
        }),
      );

      expect(rejection.constraint).toBe("institution_payment_instructions_payable_chk");
    });
  });

  it("permits exactly one instructions row per institution", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const values = {
        institutionId: fixture.institutionId,
        bankName: "BCA",
        accountNumber: "1234567890",
        accountHolderName: "Yayasan Contoh",
      };

      await tx.insert(institutionPaymentInstructions).values(values);

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(institutionPaymentInstructions).values(values),
      );

      expect(rejection.code).toBe("23505");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("competitions fee unit + currency (real database)", () => {
  it("refuses a priced competition with no currency", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .update(competitions)
          .set({ feeAmount: 50_000, feeCurrency: null })
          .where(eq(competitions.id, fixture.competitionId)),
      );

      expect(rejection.constraint).toBe("competitions_fee_currency_required_chk");
    });
  });

  it("permits a FREE competition with no currency", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const [row] = await tx
        .update(competitions)
        .set({ feeAmount: 0, feeCurrency: null })
        .where(eq(competitions.id, fixture.competitionId))
        .returning({ id: competitions.id });

      expect(row?.id).toBe(fixture.competitionId);
    });
  });

  it("refuses a malformed currency code", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .update(competitions)
          .set({ feeAmount: 50_000, feeCurrency: "rupiah" })
          .where(eq(competitions.id, fixture.competitionId)),
      );

      expect(rejection.constraint).toBe("competitions_fee_currency_shape_chk");
    });
  });

  it("stores the fee as an integer smallest unit, not a decimal", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      await tx
        .update(competitions)
        .set({ feeAmount: 50_000, feeCurrency: "IDR" })
        .where(eq(competitions.id, fixture.competitionId));

      const [row] = await tx
        .select({ feeAmount: competitions.feeAmount })
        .from(competitions)
        .where(eq(competitions.id, fixture.competitionId));

      // A number, not the "50000.00" string the old numeric column read back as.
      expect(row?.feeAmount).toBe(50_000);
      expect(typeof row?.feeAmount).toBe("number");
    });
  });

  it("refuses a payment window outside its bounds", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .update(competitions)
          .set({ paymentWindowDays: 0 })
          .where(eq(competitions.id, fixture.competitionId)),
      );

      expect(rejection.constraint).toBe("competitions_payment_window_days_chk");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the charging gate at payment creation (real database)", () => {
  const createPaymentFor = async (tx: Tx, institutionId: string, fixture: Fixture) => {
    const { createPayment } = await import("@/server/finance/payment-service");
    return createPayment(
      {
        payerUserId: fixture.userId,
        receivingInstitutionId: institutionId,
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
  };

  // THE GUARD-REMOVAL PROOF. Delete the `assertInstitutionVerified` call from createPayment and
  // this test fails: the payment is simply recorded, and an unverified institution has taken money.
  it("REFUSES a priced payment for an unverified institution", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      await expect(
        createPaymentFor(tx, fixture.unverifiedInstitutionId, fixture),
      ).rejects.toMatchObject({ code: "competition_institution_not_verified" });

      const rows = await tx
        .select({ id: financePayments.id })
        .from(financePayments)
        .where(eq(financePayments.receivingInstitutionId, fixture.unverifiedInstitutionId));

      // Not merely refused — nothing was written.
      expect(rows).toHaveLength(0);
    });
  });

  it("ALLOWS the same payment once the institution is verified", async () => {
    // The other half of the proof. Without this, a gate that refused everything unconditionally
    // would pass the test above while breaking the product.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const payment = await createPaymentFor(tx, fixture.institutionId, fixture);

      expect(payment.origin).toBe("manual_transfer");
      expect(payment.platformFeeAmount).toBe(0);
      expect(payment.institutionNetAmount).toBe(payment.grossAmount);
      expect(payment.dueAt?.toISOString()).toBe(DUE.toISOString());
    });
  });

  it("ALLOWS a FREE registration for an unverified institution (DEC-0158)", async () => {
    // Verification gates the right to CHARGE, never the right to run a competition. Refusing a
    // zero-gross payment here would make an unverified institution unable to do what DEC-0158
    // explicitly permits.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { createPayment } = await import("@/server/finance/payment-service");

      const payment = await createPayment(
        {
          payerUserId: fixture.userId,
          receivingInstitutionId: fixture.unverifiedInstitutionId,
          origin: "manual_transfer",
          subject: {
            type: "competition_registration",
            competitionRegistrationId: fixture.registrationId,
          },
          grossAmount: 0,
          currency: "IDR",
          pricedAt: NOW,
          dueAt: DUE,
        },
        tx as never,
      );

      expect(payment.grossAmount).toBe(0);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the two paid predicates (real database)", () => {
  const loadPredicates = () => import("@/server/finance/paid-registration");

  it("does NOT report a zero-gross payment as confirmed paid — row existence is not the predicate", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { isRegistrationConfirmedPaid } = await loadPredicates();

      const paymentId = await seedManualPayment(tx, fixture, {
        grossAmount: 0,
        institutionNetAmount: 0,
      });
      // Even with a succeeded event, a free registration is not a paid one.
      const { appendPaymentEvent } = await import("@/server/finance/payment-service");
      await appendPaymentEvent(
        { type: "system" },
        {
          paymentId,
          eventType: "succeeded",
          occurredAt: NOW,
          idempotencyKey: `mn:succeeded:${paymentId}:0`,
        },
        tx as never,
      );

      expect(await isRegistrationConfirmedPaid(fixture.registrationId, tx as never)).toBe(false);
    });
  });

  it("does NOT report a priced payment with no succeeded event as confirmed paid", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { isRegistrationConfirmedPaid } = await loadPredicates();

      await seedManualPayment(tx, fixture);

      expect(await isRegistrationConfirmedPaid(fixture.registrationId, tx as never)).toBe(false);
    });
  });

  it("reports confirmed paid once a priced payment folds to succeeded", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { isRegistrationConfirmedPaid } = await loadPredicates();
      const { appendPaymentEvent } = await import("@/server/finance/payment-service");

      const paymentId = await seedManualPayment(tx, fixture);
      await appendPaymentEvent(
        { type: "user", userId: fixture.userId },
        {
          paymentId,
          eventType: "succeeded",
          occurredAt: NOW,
          amount: 1_000_000,
          currency: "IDR",
          idempotencyKey: `mn:succeeded:${paymentId}:0`,
        },
        tx as never,
      );

      expect(await isRegistrationConfirmedPaid(fixture.registrationId, tx as never)).toBe(true);
    });
  });

  it("stops reporting confirmed paid after a refund folds the payment to refunded", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { isRegistrationConfirmedPaid } = await loadPredicates();
      const { appendPaymentEvent } = await import("@/server/finance/payment-service");

      const paymentId = await seedManualPayment(tx, fixture);
      await appendPaymentEvent(
        { type: "system" },
        {
          paymentId,
          eventType: "succeeded",
          occurredAt: NOW,
          amount: 1_000_000,
          currency: "IDR",
          idempotencyKey: `mn:succeeded:${paymentId}:0`,
        },
        tx as never,
      );
      await appendPaymentEvent(
        { type: "user", userId: fixture.userId },
        {
          paymentId,
          eventType: "refunded",
          occurredAt: new Date(NOW.getTime() + 1000),
          amount: 1_000_000,
          currency: "IDR",
          reason: "organiser cancelled",
          idempotencyKey: `pf:refunded:${paymentId}:00000000-0000-4000-8000-000000000000`,
        },
        tx as never,
      );

      // A status column would still say "succeeded" here. The fold is why this is trustworthy.
      expect(await isRegistrationConfirmedPaid(fixture.registrationId, tx as never)).toBe(false);
    });
  });

  it("PAYMENT IN FLIGHT fires on a submitted proof, BEFORE anything is confirmed paid", async () => {
    // The whole reason the two predicates are separate: this window is where unpublishing would
    // strand a payer, and confirmed-paid is still false throughout it.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { isRegistrationConfirmedPaid, isRegistrationPaymentInFlight } = await loadPredicates();

      const paymentId = await seedManualPayment(tx, fixture);
      await tx.insert(financeManualPaymentProofs).values({
        paymentId,
        competitionId: fixture.competitionId,
        submittedByUserId: fixture.userId,
        status: "pending_review",
        r2Key: "payment-proofs/x/y/z",
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      });

      expect(await isRegistrationPaymentInFlight(fixture.registrationId, tx as never)).toBe(true);
      expect(await isRegistrationConfirmedPaid(fixture.registrationId, tx as never)).toBe(false);
    });
  });

  it("stops reporting in flight once the proof is rejected or voided", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { isRegistrationPaymentInFlight } = await loadPredicates();

      const paymentId = await seedManualPayment(tx, fixture);
      await tx.insert(financeManualPaymentProofs).values({
        paymentId,
        competitionId: fixture.competitionId,
        submittedByUserId: fixture.userId,
        status: "rejected",
        rejectionReason: "bukan transfer ke rekening kami",
        reviewedAt: NOW,
        r2Key: "payment-proofs/x/y/z",
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      });

      expect(await isRegistrationPaymentInFlight(fixture.registrationId, tx as never)).toBe(false);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the payment group across a team (real database)", () => {
  it("marks EVERY member paid from the captain's single payment", async () => {
    // A team is N registration rows sharing a team_id but pays ONCE. Asking each row about its own
    // payment would report three of four members unpaid for a competition the team has settled.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { isRegistrationConfirmedPaid, resolvePaymentGroupRegistrationIds } = await import(
        "@/server/finance/paid-registration"
      );
      const { appendPaymentEvent } = await import("@/server/finance/payment-service");

      const id = uniqueSuffix();
      const [team] = await tx
        .insert(teams)
        .values({
          competitionId: fixture.competitionId,
          captainId: fixture.userId,
          name: `Tim ${id}`,
          status: "submitted",
        })
        .returning({ id: teams.id });

      // The captain's own row becomes the anchor; three more members join the same team.
      await tx
        .update(competitionRegistrations)
        .set({ registrationType: "team", teamId: team!.id })
        .where(eq(competitionRegistrations.id, fixture.registrationId));

      const memberIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const [member] = await tx
          .insert(users)
          .values({
            email: `member_${id}_${i}@example.test`,
            username: `member_${id}_${i}`,
            candidateVerifiedAt: NOW,
          })
          .returning({ id: users.id });

        const [registration] = await tx
          .insert(competitionRegistrations)
          .values({
            competitionId: fixture.competitionId,
            studentId: member!.id,
            registrationType: "team",
            teamId: team!.id,
          })
          .returning({ id: competitionRegistrations.id });

        memberIds.push(registration!.id);
      }

      const group = await resolvePaymentGroupRegistrationIds(fixture.registrationId, tx as never);
      expect(group).toHaveLength(4);

      // ONE payment, anchored on the captain's row.
      const paymentId = await seedManualPayment(tx, fixture);
      await appendPaymentEvent(
        { type: "system" },
        {
          paymentId,
          eventType: "succeeded",
          occurredAt: NOW,
          amount: 1_000_000,
          currency: "IDR",
          idempotencyKey: `mn:succeeded:${paymentId}:0`,
        },
        tx as never,
      );

      // Every member reads as paid — through the same predicate, with no registration_type branch.
      for (const registrationId of [fixture.registrationId, ...memberIds]) {
        expect(await isRegistrationConfirmedPaid(registrationId, tx as never)).toBe(true);
      }
    });
  });

  it("keeps an individual registration's group to itself", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { resolvePaymentGroupRegistrationIds } = await import(
        "@/server/finance/paid-registration"
      );

      const group = await resolvePaymentGroupRegistrationIds(fixture.registrationId, tx as never);
      expect(group).toEqual([fixture.registrationId]);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the accrual write is single-shot (real database)", () => {
  it("refuses a second accrual for one payment even when the service is called twice", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { recordFeeAccrual } = await import("@/server/finance/fee-accrual-service");

      const paymentId = await seedManualPayment(tx, fixture);

      const first = await recordFeeAccrual(paymentId, tx as never);
      expect(first.amount).toBe(25_000);

      await expect(recordFeeAccrual(paymentId, tx as never)).rejects.toMatchObject({
        code: "fee_accrual_already_recorded",
      });
    });
  });

  it("refuses to accrue against a gateway payment — its fee already split", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { recordFeeAccrual } = await import("@/server/finance/fee-accrual-service");

      const paymentId = await seedManualPayment(tx, fixture, {
        origin: "gateway",
        platformFeeAmount: 25_000,
        institutionNetAmount: 975_000,
        dueAt: null,
      });

      await expect(recordFeeAccrual(paymentId, tx as never)).rejects.toMatchObject({
        code: "fee_accrual_not_manual_lane",
      });
    });
  });

  it("sums an accrual and its reversal to zero outstanding", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { recordFeeAccrual, recordFeeAccrualReversal, sumOutstandingFeeAccruals } =
        await import("@/server/finance/fee-accrual-service");

      const paymentId = await seedManualPayment(tx, fixture);
      await recordFeeAccrual(paymentId, tx as never);

      expect(await sumOutstandingFeeAccruals(fixture.institutionId, tx as never)).toBe(25_000);

      await recordFeeAccrualReversal(paymentId, "proof turned out to be someone else's", tx as never);

      expect(await sumOutstandingFeeAccruals(fixture.institutionId, tx as never)).toBe(0);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the proof review loop is CAS-guarded (real database)", () => {
  const seedProof = async (tx: Tx, fixture: Fixture, paymentId: string): Promise<string> => {
    const [proof] = await tx
      .insert(financeManualPaymentProofs)
      .values({
        paymentId,
        competitionId: fixture.competitionId,
        submittedByUserId: fixture.userId,
        status: "pending_review",
        r2Key: "payment-proofs/x/y/z",
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      })
      .returning({ id: financeManualPaymentProofs.id });
    return proof!.id;
  };

  it("verifies once, writes one succeeded event and one accrual, and refuses the second verify", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId);

      await verifyManualPaymentProof(fixture.userId, proofId, tx as never, NOW);

      // The CAS is what stops the second click, before the accrual's unique index has to.
      await expect(
        verifyManualPaymentProof(fixture.userId, proofId, tx as never, NOW),
      ).rejects.toMatchObject({ code: "manual_proof_not_pending" });

      const accruals = await tx
        .select({ id: financeFeeAccruals.id })
        .from(financeFeeAccruals)
        .where(
          and(
            eq(financeFeeAccruals.paymentId, paymentId),
            eq(financeFeeAccruals.entryType, "accrued"),
          ),
        );

      expect(accruals).toHaveLength(1);
    });
  });

  it("bars a resubmission the organiser refused, in the CAS rather than in the UI", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId);

      await rejectManualPaymentProof(
        fixture.userId,
        proofId,
        "bukan transfer ke rekening kami",
        false,
        tx as never,
        NOW,
      );

      await expect(
        reopenManualPaymentProof(
          {
            proofId,
            r2Key: "payment-proofs/x/y/second",
            originalFileName: "bukti2.jpg",
            fileSizeBytes: 4096,
            contentType: "image/jpeg",
          },
          tx as never,
          NOW,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_resubmission_barred" });
    });
  });

  it("reopens an allowed resubmission, bumps the attempt, and RETAINS the rejection reason", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId);

      await rejectManualPaymentProof(
        fixture.userId,
        proofId,
        "nominal tidak sesuai",
        true,
        tx as never,
        NOW,
      );

      const reopened = await reopenManualPaymentProof(
        {
          proofId,
          r2Key: "payment-proofs/x/y/second",
          originalFileName: "bukti2.jpg",
          fileSizeBytes: 4096,
          contentType: "image/jpeg",
        },
        tx as never,
        NOW,
      );

      expect(reopened.status).toBe("pending_review");
      expect(reopened.resubmissionCount).toBe(1);
      // Retained on purpose: the reviewer of attempt two needs to see what attempt one failed on.
      expect(reopened.rejectionReason).toBe("nominal tidak sesuai");
    });
  });

  it("voids a pending proof without writing any finance event", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { voidManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { financePaymentEvents } = await import("@/server/db/schema");

      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId);

      await voidManualPaymentProof(fixture.userId, proofId, "duplicate submission", tx as never, NOW);

      const events = await tx
        .select({ id: financePaymentEvents.id })
        .from(financePaymentEvents)
        .where(eq(financePaymentEvents.paymentId, paymentId));

      // Nothing was confirmed received, so the ledger says nothing about the money.
      expect(events).toHaveLength(0);
    });
  });
});
