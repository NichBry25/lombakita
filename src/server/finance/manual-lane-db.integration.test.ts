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
  institutionMemberships,
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

/** One institution and one candidate registered on one of its competitions. */
type Tenant = {
  userId: string;
  institutionId: string;
  competitionId: string;
  registrationId: string;
};

type Fixture = Tenant & {
  unverifiedInstitutionId: string;
  feeRuleId: string;
  // A SECOND, COMPLETE TENANT. Present in every fixture rather than built ad hoc by the handful of
  // tests that remember to, because a single-tenant fixture is structurally incapable of catching a
  // missing tenant scope: 39 real-database tests ran green over proof functions that had none.
  other: Tenant;
};

const seedTenant = async (tx: Tx, label: string, verified: boolean): Promise<Tenant> => {
  const id = uniqueSuffix();

  const [user] = await tx
    .insert(users)
    .values({
      email: `${label}_${id}@example.test`,
      username: `${label}_${id}`,
      // users_one_verified_role_chk requires at least one verified role.
      candidateVerifiedAt: NOW,
    })
    .returning({ id: users.id });

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `${label}-inst-${id}`,
      institutionType: "personal",
      ...(verified ? { verificationStatus: "verified" as const } : {}),
    })
    .returning({ id: institutions.id });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `${label}-comp-${id}`,
      title: `Fixture ${label} ${id}`,
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

  return {
    userId: user!.id,
    institutionId: institution!.id,
    competitionId: competition!.id,
    registrationId: registration!.id,
  };
};

const seedFixture = async (tx: Tx): Promise<Fixture> => {
  const id = uniqueSuffix();
  const primary = await seedTenant(tx, "manual", true);
  const other = await seedTenant(tx, "rival", true);

  const [unverified] = await tx
    .insert(institutions)
    .values({ slug: `manual-unver-${id}`, institutionType: "personal" })
    .returning({ id: institutions.id });

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
    ...primary,
    unverifiedInstitutionId: unverified!.id,
    feeRuleId: feeRule!.id,
    other,
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

  it("caps a payment at one accrual and one reversal, so its signed total is the fee or zero", async () => {
    // Both arms are capped, and that is what makes the total bounded below. This test previously
    // asserted the opposite — that compensating rows were unconstrained — which is exactly the shape
    // that lets repeated reversals drive an institution's outstanding fee NEGATIVE. A negative total
    // says the platform owes the institution money, the custody direction DEC-0130 forbids.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      const reversal = { entryType: "reversed" as const, amount: -25_000, reason: "invalid proof" };

      await tx.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId));
      await tx.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId, reversal));

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId, reversal)),
      );

      expect(rejection.code).toBe("23505");
      expect(rejection.constraint).toBe("finance_fee_accruals_payment_reversed_unique_idx");

      const rows = await tx
        .select({ id: financeFeeAccruals.id })
        .from(financeFeeAccruals)
        .where(eq(financeFeeAccruals.paymentId, paymentId));

      expect(rows).toHaveLength(2);
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
  it("records ONE accrual however many times the service is called", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { recordFeeAccrual } = await import("@/server/finance/fee-accrual-service");

      const paymentId = await seedManualPayment(tx, fixture);

      const first = await recordFeeAccrual(paymentId, tx as never);
      expect(first.amount).toBe(25_000);

      // Converges rather than throwing. Throwing here rolls back the proof transition this runs
      // inside, so the organiser's next click hits the identical failure and the payment is wedged
      // for good — over a condition that is already exactly what the invariant demands.
      const second = await recordFeeAccrual(paymentId, tx as never);
      expect(second.id).toBe(first.id);

      const rows = await tx
        .select({ id: financeFeeAccruals.id })
        .from(financeFeeAccruals)
        .where(
          and(
            eq(financeFeeAccruals.paymentId, paymentId),
            eq(financeFeeAccruals.entryType, "accrued"),
          ),
        );
      expect(rows).toHaveLength(1);
    });
  });

  it("REFUSES a second reversal, so the signed total can never go negative", async () => {
    // A negative total reads as the platform owing the institution money, which is the custody
    // direction DEC-0130 forbids the platform to be in at all. Enforced by a partial unique index
    // on the reversed arm, not by a service check that a second caller could route around.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { recordFeeAccrual, recordFeeAccrualReversal, sumOutstandingFeeAccruals } =
        await import("@/server/finance/fee-accrual-service");

      const paymentId = await seedManualPayment(tx, fixture);
      await recordFeeAccrual(paymentId, tx as never);
      await recordFeeAccrualReversal(paymentId, "first correction", tx as never);

      // Run in a SAVEPOINT: the refusal comes from the database, and a failed statement leaves the
      // enclosing transaction unusable unless it is rolled back to one.
      let refusal: { code?: string } = {};
      try {
        await tx.transaction(async (nested) => {
          await recordFeeAccrualReversal(paymentId, "second correction", nested as never);
        });
      } catch (error) {
        refusal = error as { code?: string };
      }

      expect(refusal.code).toBe("fee_accrual_already_reversed");
      expect(await sumOutstandingFeeAccruals(fixture.institutionId, tx as never)).toBe(0);
    });
  });

  it("refuses a second reversal at the DATABASE, with the service bypassed entirely", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const reversal = {
        entryType: "reversed" as const,
        amount: -25_000,
        reason: "correction",
      };
      await tx.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId));
      await tx.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId, reversal));

      const failure = await expectRejection(tx, (nested) =>
        nested.insert(financeFeeAccruals).values(accrualValues(fixture, paymentId, reversal)),
      );

      expect(failure.code).toBe("23505");
      expect(failure.constraint).toBe("finance_fee_accruals_payment_reversed_unique_idx");
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

/** A pending proof, filed under the object prefix the service will hold a resubmission to. */
const seedProof = async (
  tx: Tx,
  tenant: Tenant,
  paymentId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const [proof] = await tx
    .insert(financeManualPaymentProofs)
    .values({
      paymentId,
      competitionId: tenant.competitionId,
      submittedByUserId: tenant.userId,
      status: "pending_review",
      r2Key: `payment-proofs/${tenant.competitionId}/${paymentId}/bukti.jpg`,
      originalFileName: "bukti.jpg",
      fileSizeBytes: 2048,
      contentType: "image/jpeg",
      ...overrides,
    })
    .returning({ id: financeManualPaymentProofs.id });
  return proof!.id;
};

describe.skipIf(skipWithoutDatabase)("the proof review loop is CAS-guarded (real database)", () => {

  it("verifies once, writes one succeeded event and one accrual, and refuses the second verify", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId);

      await verifyManualPaymentProof(fixture.institutionId, fixture.userId, proofId, tx as never, NOW);

      // The CAS is what stops the second click, before the accrual's unique index has to.
      await expect(
        verifyManualPaymentProof(fixture.institutionId, fixture.userId, proofId, tx as never, NOW),
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
        fixture.institutionId,
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
            submittedByUserId: fixture.userId,
            r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/second.jpg`,
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
        fixture.institutionId,
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
          submittedByUserId: fixture.userId,
          r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/second.jpg`,
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

describe.skipIf(skipWithoutDatabase)("proof access is tenant-scoped (real database)", () => {
  // A rival organiser, holding a proof id belonging to somebody else's competition. Every one of
  // these passed before the scope was added, because a single-tenant fixture cannot express the
  // question: the only institution in the test owned everything in it.
  const seedRivalProof = async (
    tx: Tx,
    fixture: Fixture,
  ): Promise<{ proofId: string; paymentId: string }> => {
    const paymentId = await seedManualPayment(tx, fixture);
    const proofId = await seedProof(tx, fixture, paymentId);
    return { proofId, paymentId };
  };

  it("refuses to verify another institution's proof, and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { financePaymentEvents } = await import("@/server/db/schema");
      const { proofId, paymentId } = await seedRivalProof(tx, fixture);

      await expect(
        verifyManualPaymentProof(
          fixture.other.institutionId,
          fixture.other.userId,
          proofId,
          tx as never,
          NOW,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_not_pending" });

      // The consequences of the missing scope, asserted rather than assumed: a succeeded event on
      // somebody else's payment, and a fee accrued against somebody else's institution.
      const events = await tx
        .select({ id: financePaymentEvents.id })
        .from(financePaymentEvents)
        .where(eq(financePaymentEvents.paymentId, paymentId));
      expect(events).toHaveLength(0);

      const accruals = await tx
        .select({ id: financeFeeAccruals.id })
        .from(financeFeeAccruals)
        .where(eq(financeFeeAccruals.paymentId, paymentId));
      expect(accruals).toHaveLength(0);

      const [proof] = await tx
        .select({ status: financeManualPaymentProofs.status })
        .from(financeManualPaymentProofs)
        .where(eq(financeManualPaymentProofs.id, proofId));
      expect(proof!.status).toBe("pending_review");
    });
  });

  it("still verifies the owning institution's own proof", async () => {
    // The negative control. Without it the scope could be refusing everything.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { proofId } = await seedRivalProof(tx, fixture);

      const verified = await verifyManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proofId,
        tx as never,
        NOW,
      );

      expect(verified.status).toBe("verified");
    });
  });

  it("refuses to reject another institution's proof", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { proofId } = await seedRivalProof(tx, fixture);

      await expect(
        rejectManualPaymentProof(
          fixture.other.institutionId,
          fixture.other.userId,
          proofId,
          "not ours",
          false,
          tx as never,
          NOW,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_not_pending" });
    });
  });

  it("hides another institution's proof from the reader entirely", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { proofId } = await seedRivalProof(tx, fixture);

      // A proof row carries the payer's object key and file name. Not found, not empty-but-present.
      expect(
        await loadManualPaymentProof(fixture.other.institutionId, proofId, tx as never),
      ).toBeNull();
      expect(await loadManualPaymentProof(fixture.institutionId, proofId, tx as never)).not.toBeNull();
    });
  });

  it("refuses a proof submitted against somebody else's payment", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { submitManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);

      await expect(
        submitManualPaymentProof(
          {
            paymentId,
            submittedByUserId: fixture.other.userId,
            r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
            originalFileName: "bukti.jpg",
            fileSizeBytes: 2048,
            contentType: "image/jpeg",
          },
          tx as never,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_payment_not_found" });
    });
  });

  it("refuses a resubmission from anyone but the payer", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { proofId, paymentId } = await seedRivalProof(tx, fixture);

      await rejectManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proofId,
        "nominal tidak sesuai",
        true,
        tx as never,
        NOW,
      );

      await expect(
        reopenManualPaymentProof(
          {
            proofId,
            submittedByUserId: fixture.other.userId,
            r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/second.jpg`,
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

  it("refuses a replacement file stored outside this payment's own prefix", async () => {
    // buildManualProofObjectPrefix is the boundary a proof row's key is held to, not a naming
    // convention. Without this check a resubmission could point the row at any object in the
    // bucket — including another payer's receipt, which this row would then present as its own.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { proofId } = await seedRivalProof(tx, fixture);

      await rejectManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proofId,
        "nominal tidak sesuai",
        true,
        tx as never,
        NOW,
      );

      await expect(
        reopenManualPaymentProof(
          {
            proofId,
            submittedByUserId: fixture.userId,
            r2Key: `payment-proofs/${fixture.other.competitionId}/someone-else/bukti.jpg`,
            originalFileName: "bukti2.jpg",
            fileSizeBytes: 4096,
            contentType: "image/jpeg",
          },
          tx as never,
          NOW,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_object_key_invalid" });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("PAYMENT IN FLIGHT is priced, not merely present", () => {
  it("ignores a proof attached to a zero-gross payment", async () => {
    // A proof against a free registration is a receipt for nothing. Counting it would block the
    // competition's unpublish and every fee change forever, with no surface anywhere to clear it.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { hasCompetitionPaymentInFlight, isRegistrationPaymentInFlight } = await import(
        "@/server/finance/paid-registration"
      );

      const freePaymentId = await seedManualPayment(tx, fixture, {
        grossAmount: 0,
        institutionNetAmount: 0,
      });
      await seedProof(tx, fixture, freePaymentId);

      expect(await hasCompetitionPaymentInFlight(fixture.competitionId, tx as never)).toBe(false);
      expect(await isRegistrationPaymentInFlight(fixture.registrationId, tx as never)).toBe(false);
    });
  });

  it("still fires on a proof attached to a priced payment", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { hasCompetitionPaymentInFlight } = await import("@/server/finance/paid-registration");

      const paymentId = await seedManualPayment(tx, fixture);
      await seedProof(tx, fixture, paymentId);

      expect(await hasCompetitionPaymentInFlight(fixture.competitionId, tx as never)).toBe(true);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("hasActiveFreeRegistrations (real database)", () => {
  it("reports a registration with no priced payment as free", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { hasActiveFreeRegistrations } = await import("@/server/finance/paid-registration");

      expect(await hasActiveFreeRegistrations(fixture.competitionId, tx as never)).toBe(true);
    });
  });

  it("stops reporting free once the registration carries a priced payment", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { hasActiveFreeRegistrations } = await import("@/server/finance/paid-registration");

      await seedManualPayment(tx, fixture);

      expect(await hasActiveFreeRegistrations(fixture.competitionId, tx as never)).toBe(false);
    });
  });

  it("still reports free when the only payment is zero-gross", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { hasActiveFreeRegistrations } = await import("@/server/finance/paid-registration");

      await seedManualPayment(tx, fixture, { grossAmount: 0, institutionNetAmount: 0 });

      expect(await hasActiveFreeRegistrations(fixture.competitionId, tx as never)).toBe(true);
    });
  });

  it("counts a team as ONE group, so members without their own payment are not free", async () => {
    // The captain pays once for four rows. Reading per row would report three free registrations on
    // a competition the team has fully settled, and block every later price change on that basis.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { hasActiveFreeRegistrations } = await import("@/server/finance/paid-registration");

      const [team] = await tx
        .insert(teams)
        .values({
          competitionId: fixture.competitionId,
          name: `Tim ${uniqueSuffix()}`,
          captainId: fixture.userId,
        })
        .returning({ id: teams.id });

      // The seeded individual row would answer "free" on its own, so it is retired first.
      await tx
        .update(competitionRegistrations)
        .set({ status: "cancelled", cancellationReason: "switched to team" })
        .where(eq(competitionRegistrations.id, fixture.registrationId));

      const memberIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const suffix = uniqueSuffix();
        const [member] = await tx
          .insert(users)
          .values({
            email: `member_${suffix}@example.test`,
            username: `member_${suffix}`,
            candidateVerifiedAt: NOW,
          })
          .returning({ id: users.id });
        const [row] = await tx
          .insert(competitionRegistrations)
          .values({
            competitionId: fixture.competitionId,
            studentId: member!.id,
            registrationType: "team",
            teamId: team!.id,
          })
          .returning({ id: competitionRegistrations.id });
        memberIds.push(row!.id);
      }

      expect(await hasActiveFreeRegistrations(fixture.competitionId, tx as never)).toBe(true);

      // One payment, anchored on one member's row, settles the whole group.
      await seedManualPayment(tx, fixture, { competitionRegistrationId: memberIds[0]! });

      expect(await hasActiveFreeRegistrations(fixture.competitionId, tx as never)).toBe(false);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("payment instructions are only readable when payable", () => {
  const seedInstructions = async (tx: Tx, institutionId: string): Promise<void> => {
    await tx.insert(institutionPaymentInstructions).values({
      institutionId,
      bankName: "Bank Contoh",
      accountNumber: "1234567890",
      accountHolderName: "Panitia Lomba",
    });
  };

  it("returns nothing for a DRAFT competition", async () => {
    // Real bank account details. A draft takes no registrations and therefore no money, so there is
    // no transaction to justify publishing somebody's account number against it.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadPaymentInstructionsForCompetition } = await import(
        "@/server/institutions/payment-instructions-service"
      );
      await seedInstructions(tx, fixture.institutionId);

      expect(
        await loadPaymentInstructionsForCompetition(fixture.competitionId, tx as never),
      ).toBeNull();
    });
  });

  it("returns nothing for a soft-deleted competition", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadPaymentInstructionsForCompetition } = await import(
        "@/server/institutions/payment-instructions-service"
      );
      await seedInstructions(tx, fixture.institutionId);
      await tx
        .update(competitions)
        .set({ status: "published", deletedAt: NOW })
        .where(eq(competitions.id, fixture.competitionId));

      expect(
        await loadPaymentInstructionsForCompetition(fixture.competitionId, tx as never),
      ).toBeNull();
    });
  });

  it("returns the instructions for a live published competition", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadPaymentInstructionsForCompetition } = await import(
        "@/server/institutions/payment-instructions-service"
      );
      await seedInstructions(tx, fixture.institutionId);
      await tx
        .update(competitions)
        .set({ status: "published" })
        .where(eq(competitions.id, fixture.competitionId));

      const instructions = await loadPaymentInstructionsForCompetition(
        fixture.competitionId,
        tx as never,
      );

      expect(instructions?.accountNumber).toBe("1234567890");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("setCompetitionFee — every gate, against a real database", () => {
  /** Makes the fixture's user the owning admin of a competition, which the fee path requires. */
  const grantOwnership = async (tx: Tx, tenant: Tenant): Promise<void> => {
    await tx.insert(institutionMemberships).values({
      institutionId: tenant.institutionId,
      userId: tenant.userId,
      membershipRole: "institution_owner",
      status: "active",
    });
  };

  const readFee = async (tx: Tx, competitionId: string) => {
    const [row] = await tx
      .select({ feeAmount: competitions.feeAmount, feeCurrency: competitions.feeCurrency })
      .from(competitions)
      .where(eq(competitions.id, competitionId));
    return row!;
  };

  const priceIt = async (tx: Tx, tenant: Tenant, feeAmount: number | null = 75_000) => {
    const { setCompetitionFee } = await import("@/server/competitions/competition-fee-service");
    return setCompetitionFee(
      tenant.userId,
      tenant.competitionId,
      { feeAmount, feeCurrency: feeAmount === null || feeAmount === 0 ? null : "IDR" },
      tx as never,
      NOW,
    );
  };

  it("prices a competition that has no free registrants", async () => {
    // The negative control for every refusal below.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await tx
        .update(competitionRegistrations)
        .set({ status: "cancelled", cancellationReason: "withdrew" })
        .where(eq(competitionRegistrations.id, fixture.registrationId));

      await priceIt(tx, fixture);

      expect(await readFee(tx, fixture.competitionId)).toEqual({
        feeAmount: 75_000,
        feeCurrency: "IDR",
      });
    });
  });

  it("REFUSES to price a competition that already took a free registration", async () => {
    // Candidate self-cancellation is refused on a priced competition, so pricing one retroactively
    // strips the right to leave from somebody who was never asked to pay and has nothing to
    // withdraw. They would be locked into an event they joined for free.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);

      await expect(priceIt(tx, fixture)).rejects.toMatchObject({
        code: "competition_fee_blocked_free_registrations",
      });

      // Refused AND nothing written — the assertion that makes this order-sensitive rather than
      // merely present. Moving the guard below the write would leave the refusal intact and this
      // expectation failing.
      expect(await readFee(tx, fixture.competitionId)).toEqual({
        feeAmount: null,
        feeCurrency: null,
      });
    });
  });

  it("still allows a price CHANGE on an already-priced competition", async () => {
    // The block is scoped to the free → paid transition, which is the whole of the harm. An
    // already-priced competition changing its price moves nobody across that boundary.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await tx
        .update(competitions)
        .set({ feeAmount: 50_000, feeCurrency: "IDR" })
        .where(eq(competitions.id, fixture.competitionId));

      await priceIt(tx, fixture, 90_000);

      expect((await readFee(tx, fixture.competitionId)).feeAmount).toBe(90_000);
    });
  });

  it("REFUSES to price for an unverified institution, and writes nothing", async () => {
    // The order-sensitive form of the charging-gate proof. Removing assertInstitutionVerified fails
    // the first expectation; moving it after the write leaves the throw in place and fails the
    // second. Presence alone is not enforcement.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await tx
        .update(institutions)
        .set({ verificationStatus: "pending_verification" })
        .where(eq(institutions.id, fixture.institutionId));
      await tx
        .update(competitionRegistrations)
        .set({ status: "cancelled", cancellationReason: "withdrew" })
        .where(eq(competitionRegistrations.id, fixture.registrationId));

      await expect(priceIt(tx, fixture)).rejects.toMatchObject({
        code: "competition_institution_not_verified",
      });

      expect(await readFee(tx, fixture.competitionId)).toEqual({
        feeAmount: null,
        feeCurrency: null,
      });
    });
  });

  it("still lets an unverified institution set its competition back to FREE", async () => {
    // Revocation is a credibility change, not a takedown. Trapping an organiser into keeping a price
    // it can no longer honour would make it one.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await tx
        .update(competitions)
        .set({ feeAmount: 50_000, feeCurrency: "IDR" })
        .where(eq(competitions.id, fixture.competitionId));
      await tx
        .update(institutions)
        .set({ verificationStatus: "pending_verification" })
        .where(eq(institutions.id, fixture.institutionId));

      await priceIt(tx, fixture, 0);

      expect(await readFee(tx, fixture.competitionId)).toEqual({
        feeAmount: null,
        feeCurrency: null,
      });
    });
  });

  it("REFUSES a price change while a bukti transfer is outstanding, and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await tx
        .update(competitions)
        .set({ feeAmount: 50_000, feeCurrency: "IDR" })
        .where(eq(competitions.id, fixture.competitionId));

      const paymentId = await seedManualPayment(tx, fixture);
      await seedProof(tx, fixture, paymentId);

      await expect(priceIt(tx, fixture, 90_000)).rejects.toMatchObject({
        code: "competition_fee_change_blocked_payment_in_flight",
      });

      expect((await readFee(tx, fixture.competitionId)).feeAmount).toBe(50_000);
    });
  });

  it("REFUSES to price when no fee rule is in force, and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await tx
        .update(competitionRegistrations)
        .set({ status: "cancelled", cancellationReason: "withdrew" })
        .where(eq(competitionRegistrations.id, fixture.registrationId));
      await tx.delete(financeFeeRules).where(eq(financeFeeRules.id, fixture.feeRuleId));

      await expect(priceIt(tx, fixture)).rejects.toMatchObject({
        code: "fee_rule_not_in_force",
      });

      expect(await readFee(tx, fixture.competitionId)).toEqual({
        feeAmount: null,
        feeCurrency: null,
      });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the charging gate at PUBLISH (real database)", () => {
  const publishIt = async (tx: Tx, tenant: Tenant) => {
    const { transitionCompetitionStatus } = await import(
      "@/server/competitions/competition-service"
    );
    return transitionCompetitionStatus(
      tenant.userId,
      tenant.competitionId,
      "published",
      tx as never,
    );
  };

  const makePublishable = async (tx: Tx, tenant: Tenant): Promise<void> => {
    await tx.insert(institutionMemberships).values({
      institutionId: tenant.institutionId,
      userId: tenant.userId,
      membershipRole: "institution_owner",
      status: "active",
    });
    // Publishing is separately gated on the ACCOUNT-level Trusted Recruiter tier, which is a
    // different axis from institution verification. Cleared here so what these tests measure is the
    // charging gate and nothing else.
    await tx
      .update(users)
      .set({ recruiterVerifiedAt: NOW, recruiterVerificationTier: "elevated" })
      .where(eq(users.id, tenant.userId));
    await tx
      .update(competitions)
      .set({
        status: "draft",
        description: "Deskripsi kompetisi yang cukup panjang untuk lolos validasi publikasi.",
        category: "hackathon",
        mode: "individual",
        registrationStartAt: new Date(NOW.getTime() + 1 * 86_400_000),
        registrationEndAt: new Date(NOW.getTime() + 10 * 86_400_000),
        participantConfirmationAt: new Date(NOW.getTime() + 12 * 86_400_000),
        eventStartAt: new Date(NOW.getTime() + 20 * 86_400_000),
        eventEndAt: new Date(NOW.getTime() + 21 * 86_400_000),
        resultAnnouncementAt: new Date(NOW.getTime() + 25 * 86_400_000),
        minimumParticipantEntries: 1,
      })
      .where(eq(competitions.id, tenant.competitionId));
  };

  const readStatus = async (tx: Tx, competitionId: string): Promise<string> => {
    const [row] = await tx
      .select({ status: competitions.status })
      .from(competitions)
      .where(eq(competitions.id, competitionId));
    return row!.status;
  };

  // THE GUARD-REMOVAL PROOF AT THE PUBLISH SITE. Delete the assertInstitutionVerified call from
  // transitionCompetitionStatus and this fails: the competition simply goes live, priced, for an
  // institution with no right to charge. The whole suite was green with that guard removed.
  it("REFUSES to publish a PAID competition for an unverified institution, and it stays draft", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await makePublishable(tx, fixture);
      await tx
        .update(competitions)
        .set({ feeAmount: 75_000, feeCurrency: "IDR" })
        .where(eq(competitions.id, fixture.competitionId));
      await tx
        .update(institutions)
        .set({ verificationStatus: "pending_verification" })
        .where(eq(institutions.id, fixture.institutionId));

      await expect(publishIt(tx, fixture)).rejects.toMatchObject({
        code: "competition_institution_not_verified",
      });

      expect(await readStatus(tx, fixture.competitionId)).toBe("draft");
    });
  });

  it("PUBLISHES a FREE competition for the same unverified institution", async () => {
    // Verification gates the right to CHARGE, never the right to PUBLISH. Without this half, a gate
    // that refused every publish would pass the test above while breaking the product.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await makePublishable(tx, fixture);
      await tx
        .update(institutions)
        .set({ verificationStatus: "pending_verification" })
        .where(eq(institutions.id, fixture.institutionId));

      await publishIt(tx, fixture);

      expect(await readStatus(tx, fixture.competitionId)).toBe("published");
    });
  });

  it("PUBLISHES a paid competition once the institution is verified", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await makePublishable(tx, fixture);
      await tx
        .update(competitions)
        .set({ feeAmount: 75_000, feeCurrency: "IDR" })
        .where(eq(competitions.id, fixture.competitionId));

      await publishIt(tx, fixture);

      expect(await readStatus(tx, fixture.competitionId)).toBe("published");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("cancelCompetitionAsOps — the DEC-0132 escape hatch", () => {
  const seedOperator = async (tx: Tx): Promise<string> => {
    const id = uniqueSuffix();
    const [operator] = await tx
      .insert(users)
      .values({
        email: `ops_${id}@example.test`,
        username: `ops_${id}`,
        candidateVerifiedAt: NOW,
      })
      .returning({ id: users.id });
    return operator!.id;
  };

  /** A published, priced competition with one registrant whose transfer is outstanding. */
  const seedBlockedCompetition = async (tx: Tx, fixture: Fixture): Promise<string> => {
    await tx.insert(institutionMemberships).values({
      institutionId: fixture.institutionId,
      userId: fixture.userId,
      membershipRole: "institution_owner",
      status: "active",
    });
    await tx
      .update(competitions)
      .set({ status: "published", feeAmount: 75_000, feeCurrency: "IDR" })
      .where(eq(competitions.id, fixture.competitionId));

    const paymentId = await seedManualPayment(tx, fixture);
    await seedProof(tx, fixture, paymentId);
    return paymentId;
  };

  const readCompetition = async (tx: Tx, competitionId: string) => {
    const [row] = await tx
      .select({ status: competitions.status, cancelledAt: competitions.cancelledAt })
      .from(competitions)
      .where(eq(competitions.id, competitionId));
    return row!;
  };

  it("takes the competition down, not just its registrations", async () => {
    // The defect this replaces: only competition_registrations was written, so every entrant was
    // cancelled while the competition stayed published and publicly registerable — a candidate
    // could join minutes after it had been cancelled out from under its own entrants.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { cancelCompetitionAsOps } = await import("@/server/finance/ops-payment-service");
      const { unpublishCompetition } = await import("@/server/competitions/competition-service");
      const operatorId = await seedOperator(tx);
      await seedBlockedCompetition(tx, fixture);

      // The organiser is blocked, which is the reason this hatch exists at all.
      await expect(
        unpublishCompetition(fixture.userId, fixture.competitionId, tx as never, NOW),
      ).rejects.toMatchObject({ code: "competition_unpublish_blocked_payment_in_flight" });

      const result = await cancelCompetitionAsOps(
        operatorId,
        fixture.competitionId,
        "organiser cannot run the event",
        tx as never,
        NOW,
      );

      expect(result.cancelledRegistrationCount).toBe(1);
      // The state the organiser was blocked from reaching has now been reached.
      expect((await readCompetition(tx, fixture.competitionId)).status).toBe("draft");

      const [registration] = await tx
        .select({ status: competitionRegistrations.status })
        .from(competitionRegistrations)
        .where(eq(competitionRegistrations.id, fixture.registrationId));
      expect(registration!.status).toBe("cancelled");
    });
  });

  it("writes an audit row carrying its reason in the reason column", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { cancelCompetitionAsOps } = await import("@/server/finance/ops-payment-service");
      const { platformOpsAuditLogs } = await import("@/server/db/schema");
      const operatorId = await seedOperator(tx);
      await seedBlockedCompetition(tx, fixture);

      await cancelCompetitionAsOps(
        operatorId,
        fixture.competitionId,
        "organiser cannot run the event",
        tx as never,
        NOW,
      );

      const [audit] = await tx
        .select({
          eventType: platformOpsAuditLogs.eventType,
          reason: platformOpsAuditLogs.reason,
          targetInstitutionId: platformOpsAuditLogs.targetInstitutionId,
        })
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.actorUserId, operatorId));

      expect(audit!.eventType).toBe("platform_ops_competition_cancelled");
      expect(audit!.reason).toBe("organiser cannot run the event");
      expect(audit!.targetInstitutionId).toBe(fixture.institutionId);
    });
  });

  it("refuses without a reason, and refuses a competition that is not published", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { cancelCompetitionAsOps } = await import("@/server/finance/ops-payment-service");
      const operatorId = await seedOperator(tx);
      await seedBlockedCompetition(tx, fixture);

      await expect(
        cancelCompetitionAsOps(operatorId, fixture.competitionId, "   ", tx as never, NOW),
      ).rejects.toMatchObject({ code: "ops_reason_required" });

      await tx
        .update(competitions)
        .set({ status: "draft" })
        .where(eq(competitions.id, fixture.competitionId));

      await expect(
        cancelCompetitionAsOps(operatorId, fixture.competitionId, "why", tx as never, NOW),
      ).rejects.toMatchObject({ code: "ops_competition_not_published" });
    });
  });

  it("leaves the outstanding proof alone — voiding it is its own audited decision", async () => {
    // Bundling the two would let one click both cancel a competition and silently discard the
    // evidence that somebody paid for it.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { cancelCompetitionAsOps, voidPaymentProofAsOps } = await import(
        "@/server/finance/ops-payment-service"
      );
      const { hasCompetitionPaymentInFlight } = await import("@/server/finance/paid-registration");
      const operatorId = await seedOperator(tx);
      await seedBlockedCompetition(tx, fixture);

      await cancelCompetitionAsOps(operatorId, fixture.competitionId, "reason", tx as never, NOW);

      const [proof] = await tx
        .select({ id: financeManualPaymentProofs.id, status: financeManualPaymentProofs.status })
        .from(financeManualPaymentProofs)
        .where(eq(financeManualPaymentProofs.competitionId, fixture.competitionId));
      expect(proof!.status).toBe("pending_review");
      expect(await hasCompetitionPaymentInFlight(fixture.competitionId, tx as never)).toBe(true);

      // The second, separately audited decision is what clears it.
      await voidPaymentProofAsOps(operatorId, proof!.id, "refunded by bank", tx as never, NOW);

      expect(await hasCompetitionPaymentInFlight(fixture.competitionId, tx as never)).toBe(false);
    });
  });
});
