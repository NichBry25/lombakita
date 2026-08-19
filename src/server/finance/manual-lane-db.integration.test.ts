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
import {
  TEST_DATABASE_URL,
  TEST_DDL_DATABASE_URL,
  skipWithoutDatabase,
} from "@/server/testing/database-url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import type { Database } from "@/server/db/client";
import { CompetitionError } from "@/server/competitions/competition-core";
import { PaymentInstructionsError } from "@/server/institutions/payment-instructions-service";
import {
  competitionRegistrations,
  competitions,
  financeFeeAccruals,
  financeFeeDisclosureAcknowledgements,
  financeFeeRules,
  financeManualPaymentProofAttempts,
  financeManualPaymentProofs,
  financePaymentEvents,
  financePaymentInstructionSnapshots,
  financePayments,
  institutionAuditLogs,
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
/**
 * The driver error inside whatever Drizzle threw.
 *
 * Drizzle wraps a failed query, so the SQLSTATE is on `cause` rather than on the error itself and
 * reading `error.code` directly returns undefined against a real database.
 */
const driverErrorOf = (error: unknown): { code: string; constraint: string } | null => {
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
  return null;
};

const sqlStateOf = (error: unknown): string | null => driverErrorOf(error)?.code ?? null;

const expectRejection = async (
  tx: Tx,
  body: (tx: Tx) => Promise<unknown>,
): Promise<{ code: string; constraint: string }> => {
  try {
    await tx.transaction(async (nested) => {
      await body(nested);
    });
  } catch (error) {
    const driver = driverErrorOf(error);
    if (driver) return driver;
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

  // The primary tenant can be paid. `createPayment` refuses a PRICED manual payment for an
  // institution that has published no account, so without this every fixture built here would be
  // an institution charging money it has given nobody a way to send. The unverified tenant is left
  // without instructions deliberately — it is the one the charging-gate tests expect to be refused,
  // and giving it an account would let a broken verification gate pass on the instructions gate's
  // refusal instead.
  await tx.insert(institutionPaymentInstructions).values({
    institutionId: primary.institutionId,
    bankName: "Bank Contoh",
    accountNumber: "1234567890",
    accountHolderName: "Panitia Lomba",
  });

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
      // The tenant with no instructions of its own, so the FIRST insert below is the one that
      // succeeds. Pointing this at the primary tenant — which the fixture already gives an account
      // — would make the first insert the refused one and the test would pass while proving
      // nothing about the second.
      const values = {
        institutionId: fixture.unverifiedInstitutionId,
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

      // CLEARED on the live row. Attempt one's reason belonged to attempt one; leaving it here
      // would show the reviewer of attempt two a refusal of a file they are not looking at.
      expect(reopened.rejectionReason).toBeNull();

      // And PRESERVED where it now belongs, against the attempt it actually judged — together with
      // the file that attempt uploaded, which the live row has since overwritten.
      const attempts = await tx
        .select()
        .from(financeManualPaymentProofAttempts)
        .where(eq(financeManualPaymentProofAttempts.proofId, proofId));

      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.attemptNumber).toBe(0);
      expect(attempts[0]!.verdict).toBe("rejected");
      expect(attempts[0]!.verdictReason).toBe("nominal tidak sesuai");
      expect(attempts[0]!.r2Key).toContain("bukti.jpg");
      expect(reopened.r2Key).toContain("second.jpg");
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

describe.skipIf(skipWithoutDatabase)("the object key is held to its own payment's prefix", () => {
  // buildManualProofObjectPrefix is the boundary a proof row's key is held to, not a naming
  // convention. BOTH write paths enforce it: checking only the resubmission would leave the boundary
  // open on the side that carries most of the traffic.
  const submitWithKey = async (tx: Tx, fixture: Fixture, paymentId: string, r2Key: string) => {
    const { submitManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return submitManualPaymentProof(
      {
        paymentId,
        submittedByUserId: fixture.userId,
        r2Key,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      },
      tx as never,
    );
  };

  const countProofs = async (tx: Tx, paymentId: string): Promise<number> => {
    const rows = await tx
      .select({ id: financeManualPaymentProofs.id })
      .from(financeManualPaymentProofs)
      .where(eq(financeManualPaymentProofs.paymentId, paymentId));
    return rows.length;
  };

  it("accepts a FIRST submission under this payment's own prefix", async () => {
    // The negative control. A validator that refused everything would pass every test below while
    // making it impossible to file any bukti transfer at all.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const proof = await submitWithKey(
        tx,
        fixture,
        paymentId,
        `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
      );

      expect(proof.status).toBe("pending_review");
      expect(await countProofs(tx, paymentId)).toBe(1);
    });
  });

  it("accepts a key nested deeper under its own prefix", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const proof = await submitWithKey(
        tx,
        fixture,
        paymentId,
        `payment-proofs/${fixture.competitionId}/${paymentId}/2026/08/bukti.jpg`,
      );

      expect(proof.status).toBe("pending_review");
    });
  });

  it("REFUSES a first submission pointed at another competition, and writes nothing", async () => {
    // The order-sensitive assertion. Moving the check below the insert leaves the throw in place and
    // fails this second expectation.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await expect(
        submitWithKey(
          tx,
          fixture,
          paymentId,
          `payment-proofs/${fixture.other.competitionId}/${paymentId}/bukti.jpg`,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_object_key_invalid" });

      expect(await countProofs(tx, paymentId)).toBe(0);
    });
  });

  it("REFUSES a first submission pointed at another PAYMENT under the same competition", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await expect(
        submitWithKey(
          tx,
          fixture,
          paymentId,
          `payment-proofs/${fixture.competitionId}/some-other-payment/bukti.jpg`,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_object_key_invalid" });

      expect(await countProofs(tx, paymentId)).toBe(0);
    });
  });

  it("REFUSES a key carrying a `..` segment on BOTH write paths", async () => {
    // Not exploitable against R2, where an object key is a literal string and `..` resolves to
    // nothing. Refused anyway: that is a property of the current storage layer rather than of the
    // key, and keys travel.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const paymentId = await seedManualPayment(tx, fixture);
      const traversal = `payment-proofs/${fixture.competitionId}/${paymentId}/../../${fixture.other.competitionId}/x/bukti.jpg`;

      await expect(submitWithKey(tx, fixture, paymentId, traversal)).rejects.toMatchObject({
        code: "manual_proof_object_key_invalid",
      });
      expect(await countProofs(tx, paymentId)).toBe(0);

      // And the same key on the resubmission path.
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

      await expect(
        reopenManualPaymentProof(
          {
            proofId,
            submittedByUserId: fixture.userId,
            r2Key: traversal,
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

  it("REFUSES a key equal to the prefix — a folder is not evidence", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await expect(
        submitWithKey(
          tx,
          fixture,
          paymentId,
          `payment-proofs/${fixture.competitionId}/${paymentId}/`,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_object_key_invalid" });

      expect(await countProofs(tx, paymentId)).toBe(0);
    });
  });

  it("REFUSES a sibling whose competition id merely STARTS with this one", async () => {
    // The trailing slash in the prefix is what makes this a refusal rather than a match.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await expect(
        submitWithKey(
          tx,
          fixture,
          paymentId,
          `payment-proofs/${fixture.competitionId}X/${paymentId}/bukti.jpg`,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_object_key_invalid" });

      expect(await countProofs(tx, paymentId)).toBe(0);
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
  // The fixture's primary institution already publishes instructions — a priced manual payment
  // cannot be created without them — so these tests assert that the COMPETITION's state is what
  // withholds them, with the instructions themselves known to exist.
  it("returns nothing for a DRAFT competition", async () => {
    // Real bank account details. A draft takes no registrations and therefore no money, so there is
    // no transaction to justify publishing somebody's account number against it.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadPaymentInstructionsForCompetition } = await import(
        "@/server/institutions/payment-instructions-service"
      );

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

  const priceIt = async (
    tx: Tx,
    tenant: Tenant,
    feeAmount: number | null = 75_000,
    overrides: Record<string, unknown> = {},
  ) => {
    const { setCompetitionFee } = await import("@/server/competitions/competition-fee-service");
    return setCompetitionFee(
      tenant.userId,
      tenant.competitionId,
      {
        feeAmount,
        feeCurrency: feeAmount === null || feeAmount === 0 ? null : "IDR",
        // Enabling a price requires the organiser to have acknowledged the platform's rate. The
        // gate itself gets its own tests below; here it is satisfied so the OTHER gates are what
        // each test is measuring.
        feeDisclosureAcknowledged: true,
        ...overrides,
      },
      tx as never,
      NOW,
    );
  };

  /** The fixture registers a candidate for free; pricing is blocked while one exists. */
  const clearFreeRegistrant = async (tx: Tx, tenant: Tenant): Promise<void> => {
    await tx
      .update(competitionRegistrations)
      .set({ status: "cancelled", cancellationReason: "withdrew" })
      .where(eq(competitionRegistrations.id, tenant.registrationId));
  };

  const acknowledgementsFor = async (tx: Tx, competitionId: string) =>
    tx
      .select({ id: financeFeeDisclosureAcknowledgements.id })
      .from(financeFeeDisclosureAcknowledgements)
      .where(eq(financeFeeDisclosureAcknowledgements.competitionId, competitionId));

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

  // R12 — PAYMENT INSTRUCTIONS ARE A PRECONDITION. This is where surface 3's work becomes
  // load-bearing: enabling a price for an institution that has published nowhere to send the money
  // produces a candidate owing a debt they cannot discharge and nobody able to tell them where.
  it("REFUSES to price an institution that has published no payment instructions, and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await clearFreeRegistrant(tx, fixture);

      // seedFixture publishes instructions for the primary tenant, because almost every other test
      // needs a chargeable institution. Removing them is what puts this fixture in the state the
      // gate is about.
      await tx
        .delete(institutionPaymentInstructions)
        .where(eq(institutionPaymentInstructions.institutionId, fixture.institutionId));

      // PaymentInstructionsError, not CompetitionError. Worth asserting the exact family: the
      // route converts three of them, and it originally converted one — sending this refusal, the
      // most likely legitimate one on the surface, out as an English HTTP 500.
      await expect(priceIt(tx, fixture)).rejects.toBeInstanceOf(PaymentInstructionsError);

      expect(await readFee(tx, fixture.competitionId)).toEqual({
        feeAmount: null,
        feeCurrency: null,
      });
    });
  });

  it("prices the SAME institution once instructions exist — the precondition's control", async () => {
    // Without this the refusal above could be caused by anything the fixture happens to lack.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await clearFreeRegistrant(tx, fixture);

      await tx
        .delete(institutionPaymentInstructions)
        .where(eq(institutionPaymentInstructions.institutionId, fixture.institutionId));
      await expect(priceIt(tx, fixture)).rejects.toBeInstanceOf(PaymentInstructionsError);

      await tx.insert(institutionPaymentInstructions).values({
        institutionId: fixture.institutionId,
        bankName: "Bank Contoh",
        accountNumber: "1234567890",
        accountHolderName: "Panitia Lomba",
      });

      await priceIt(tx, fixture);

      expect((await readFee(tx, fixture.competitionId)).feeAmount).toBe(75_000);
    });
  });

  it("still lets an institution with no instructions set its competition back to FREE", async () => {
    // Same asymmetry as the verification gate: the gates exist to stop money being taken, and none
    // of them has anything to say about stopping.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await clearFreeRegistrant(tx, fixture);
      await tx
        .delete(institutionPaymentInstructions)
        .where(eq(institutionPaymentInstructions.institutionId, fixture.institutionId));

      await priceIt(tx, fixture, 0);

      expect(await readFee(tx, fixture.competitionId)).toEqual({
        feeAmount: null,
        feeCurrency: null,
      });
    });
  });

  // R2 — THE DISCLOSURE IS RECORDED, not displayed. A rate the organiser was shown and a rate they
  // are billed at are the same fact only if the platform kept the evidence.
  it("REFUSES to price without an acknowledgement, and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await clearFreeRegistrant(tx, fixture);

      await expect(
        priceIt(tx, fixture, 75_000, { feeDisclosureAcknowledged: false }),
      ).rejects.toBeInstanceOf(CompetitionError);

      expect(await readFee(tx, fixture.competitionId)).toEqual({
        feeAmount: null,
        feeCurrency: null,
      });
      expect(await acknowledgementsFor(tx, fixture.competitionId)).toEqual([]);
    });
  });

  it("REFUSES a MISSING acknowledgement exactly as it refuses a false one", async () => {
    // An omitted field must not read as consent. `feeDisclosureAcknowledged` is optional in the
    // input type, so absence is the shape a client produces by simply not implementing it.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await clearFreeRegistrant(tx, fixture);

      await expect(
        priceIt(tx, fixture, 75_000, { feeDisclosureAcknowledged: undefined }),
      ).rejects.toBeInstanceOf(CompetitionError);

      expect(await acknowledgementsFor(tx, fixture.competitionId)).toEqual([]);
    });
  });

  it("RECORDS the acknowledgement with the rate snapshot and the price it was given for", async () => {
    // The columns are the point. A row saying only "somebody agreed" settles no dispute; the
    // dispute is always about WHICH RATE, so the terms are copied in rather than referenced.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await clearFreeRegistrant(tx, fixture);

      await priceIt(tx, fixture, 75_000);

      const [ack] = await tx
        .select()
        .from(financeFeeDisclosureAcknowledgements)
        .where(eq(financeFeeDisclosureAcknowledgements.competitionId, fixture.competitionId));

      expect(ack).toMatchObject({
        institutionId: fixture.institutionId,
        acknowledgedByUserId: fixture.userId,
        feeRuleId: fixture.feeRuleId,
        feeBasisPoints: 250,
        feeFlatAmount: 0,
        feeAmount: 75_000,
        feeCurrency: "IDR",
      });
      expect(ack!.acknowledgedAt).toBeInstanceOf(Date);
    });
  });

  it("writes the acknowledgement and the price TOGETHER OR NOT AT ALL", async () => {
    // They share a transaction. An acknowledgement standing over a price that was never written
    // evidences consent to a bill nobody incurred; a price with no acknowledgement is the evidence
    // gap the gate exists to close. Forcing the fee write to fail proves the pairing rather than
    // asserting it from the source.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await clearFreeRegistrant(tx, fixture);

      // A negative payment window violates the competitions CHECK, so the UPDATE inside the
      // transaction fails after the acknowledgement insert has already run.
      await expect(
        priceIt(tx, fixture, 75_000, { paymentWindowDays: 0 }),
      ).rejects.toBeDefined();

      expect(await acknowledgementsFor(tx, fixture.competitionId)).toEqual([]);
      expect((await readFee(tx, fixture.competitionId)).feeAmount).toBeNull();
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

  it("REFUSES to CLEAR a fee while a bukti transfer is outstanding, and writes nothing", async () => {
    // THE UNPROTECTED DIRECTION, and the one place the classifier's POSITION is load-bearing rather
    // than merely correct.
    //
    // The matrix blocks a feeAmount change whenever money is in flight, whatever the direction —
    // so paid→free is blocked too. But the clear path writes OUTSIDE any transaction, unlike the
    // priced path. Move the classifier below the write there and the fee is genuinely gone, with no
    // rollback to undo it: a candidate has transferred real rupiah against a price the competition
    // no longer has, and the organiser has no record of what they were charged.
    //
    // Class B, so post-state is the correct detector here — which is exactly why the priced path
    // needed a different one. Same guard, two call paths, two classes.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await tx
        .update(competitions)
        .set({ feeAmount: 50_000, feeCurrency: "IDR" })
        .where(eq(competitions.id, fixture.competitionId));

      const paymentId = await seedManualPayment(tx, fixture);
      await seedProof(tx, fixture, paymentId);

      await expect(priceIt(tx, fixture, 0)).rejects.toMatchObject({
        code: "competition_fee_change_blocked_payment_in_flight",
      });

      // The fee is still there. Under a moved classifier this reads null.
      expect(await readFee(tx, fixture.competitionId)).toEqual({
        feeAmount: 50_000,
        feeCurrency: "IDR",
      });
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CODE DEPLOYED AHEAD OF ITS MIGRATION.
//
// The deploy pipeline runs no migrations and performs no schema-drift check, so nothing prevents
// the payment-creating code reaching an environment that has not applied 0059. Accepting that gap
// rests ENTIRELY on the failure being atomic and loud rather than partial: a payment row surviving
// without its instructions snapshot would be a debt whose payer cannot be told where to send the
// money, and it would look like ordinary data rather than a fault.
//
// Asserted here rather than reasoned about, because "the insert is inside the transaction so it
// must roll back" stays true right up until someone moves the insert — which is the one change
// this file has to notice.
//
// Runs on the OWNER connection. The application role cannot drop a table (42501), which is a real
// protection worth keeping; a probe asking what happens without the table has to borrow the role
// that could remove it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const ddlClient = TEST_DDL_DATABASE_URL ? postgres(TEST_DDL_DATABASE_URL, { max: 1 }) : null;
const ddlDb = ddlClient ? drizzle(ddlClient) : null;

afterAll(async () => {
  await ddlClient?.end();
});

describe.skipIf(skipWithoutDatabase)("code deployed ahead of migration 0059", () => {
  /**
   * Runs `body` with the snapshot table removed, inside a transaction that ALWAYS rolls back.
   *
   * Rule 35: this probe removes a table, so it owes a post-condition at least as strong as the
   * guard it tests. Postgres DDL is transactional, so the rollback restores the table whether the
   * body passes, fails or throws — there is no teardown step that could itself be skipped, which
   * is the failure mode a `finally` block still has. `lock_timeout` covers the one thing rollback
   * cannot: a conflicting lock held by a parallel test file fails this in seconds, never hangs.
   */
  const withoutSnapshotTable = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
    if (!ddlDb) throw new Error("no DDL database");
    try {
      await ddlDb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);

        try {
          await tx.execute(sql`DROP TABLE finance_payment_instruction_snapshots`);
        } catch (error) {
          // NEVER A SKIP. `TEST_DDL_DATABASE_URL` falls back to `DATABASE_URL`, and locally that is
          // the application role, which does not own the finance tables — so the single likeliest
          // misconfiguration of this probe is one where it cannot remove anything. Skipping there
          // would leave a probe that reports success while doing nothing, against exactly the
          // failure it exists to catch. It fails, and it names the fix.
          if (sqlStateOf(error) === "42501") {
            throw new Error(
              "This probe must run as the owner of finance_payment_instruction_snapshots and is " +
                "connected as a role that cannot drop it (42501). Set MIGRATION_DATABASE_URL — " +
                "TEST_DDL_DATABASE_URL falls back to DATABASE_URL, which locally is the " +
                "application role. Do NOT relax this into a skip.",
              { cause: error },
            );
          }
          throw error;
        }

        const gone = await tx.execute(
          sql`select 1 from information_schema.tables
              where table_name = 'finance_payment_instruction_snapshots'`,
        );
        // Without this the assertions below would pass against a DROP that silently did nothing.
        expect([...gone], "the probe did not actually remove the table").toHaveLength(0);

        await body(tx as unknown as Tx);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    }
  };

  it("refuses a PRICED payment atomically — no orphan payment row survives", async () => {
    await withoutSnapshotTable(async (tx) => {
      const fixture = await seedFixture(tx);
      const { createPayment } = await import("@/server/finance/payment-service");

      await expect(
        createPayment(
          {
            payerUserId: fixture.userId,
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
        ),
      ).rejects.toThrow();

      // THE WHOLE RULING RESTS ON THIS QUERY, and it is load-bearing in two different ways.
      //
      // What it proves directly: no payment row survived the refusal.
      //
      // What it proves incidentally, and what actually catches the regression that matters: that
      // the refusal left this transaction USABLE. Move the snapshot insert outside
      // `createPayment`'s transaction and the payment insert releases its savepoint before the
      // failure escapes, poisoning the enclosing transaction — and this SELECT is what goes red,
      // with 25P02 rather than a row count.
      //
      // Verified by performing that move and watching this test fail. Stated explicitly because a
      // rollback harness structurally CANNOT observe the orphan itself: everything here runs inside
      // one real transaction, so a leaked write and a rolled-back one are indistinguishable by row
      // count. The transaction's health is the observable that separates them.
      const orphans = await tx
        .select({ id: financePayments.id })
        .from(financePayments)
        .where(eq(financePayments.competitionRegistrationId, fixture.registrationId));

      expect(orphans, "a payment survived without its instructions snapshot").toHaveLength(0);
    });
  });

  it("leaves the FREE registration path untouched", async () => {
    // A zero-gross payment takes no snapshot, so the absent table is not on its path at all. This
    // is what bounds the accepted gap: an environment behind on 0059 loses paid registration, and
    // free registration — the overwhelming majority of the product — is unaffected.
    await withoutSnapshotTable(async (tx) => {
      const fixture = await seedFixture(tx);
      const { createPayment } = await import("@/server/finance/payment-service");

      const payment = await createPayment(
        {
          payerUserId: fixture.userId,
          receivingInstitutionId: fixture.institutionId,
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

  it("puts the table back, so the probe leaves the database as it found it", async () => {
    // Rule 35's post-condition, asserted on a DIFFERENT connection from the one that removed the
    // table and after the transactions that removed it. Last in the block so it observes what the
    // two probes above actually left behind.
    if (!db) throw new Error("no database");

    const present = await db.execute(
      sql`select 1 from information_schema.tables
          where table_name = 'finance_payment_instruction_snapshots'`,
    );

    expect([...present], "the probe dropped a finance table and did not restore it").toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CHARGING GATE, REACHED THROUGH THE REAL REGISTRATION PATH.
//
// `createPayment` carries two guards — the institution must be verified, and it must have published
// an account to be paid into. Both were already unit-tested against `createPayment` called
// directly. That proves the FUNCTION and not the WIRING, and the wiring is where this project's
// worst defect lived: six passing tests over a block that had never once executed because the
// caller never populated the fields it read.
//
// So every test here starts at `createIndividualRegistration` — the function the route calls — and
// never constructs a payment input by hand.
//
// Each refusal also asserts NO REGISTRATION ROW SURVIVES, which is the guard-MOVE detector: move
// `createRegistrationPayment` outside the registration's transaction and the registration commits
// while the payment is refused, leaving a candidate registered for a competition that could not
// price them.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(skipWithoutDatabase)("registering for a priced competition", () => {
  const REGISTRATION_CLOSES = new Date("2026-09-30T00:00:00.000Z");

  /** A published competition a fresh candidate can actually register for. */
  const seedRegisterable = async (
    tx: Tx,
    options: { verified: boolean; withInstructions: boolean; feeAmount: number | null },
  ) => {
    const tenant = await seedTenant(tx, "reg", options.verified);
    const id = uniqueSuffix();

    if (options.withInstructions) {
      await tx.insert(institutionPaymentInstructions).values({
        institutionId: tenant.institutionId,
        bankName: "Bank Contoh",
        accountNumber: "1234567890",
        accountHolderName: "Panitia Lomba",
      });
    }

    await tx.insert(financeFeeRules).values({
      institutionId: tenant.institutionId,
      currency: "IDR",
      basisPoints: 250,
      flatAmount: 0,
      effectiveFrom: LAST_MONTH,
    });

    await tx
      .update(competitions)
      .set({
        status: "published",
        mode: "individual",
        registrationEndAt: REGISTRATION_CLOSES,
        feeAmount: options.feeAmount,
        feeCurrency: options.feeAmount === null ? null : "IDR",
        paymentWindowDays: 3,
      })
      .where(eq(competitions.id, tenant.competitionId));

    // A candidate with no registration of their own — the fixture's own user already holds one.
    const [candidate] = await tx
      .insert(users)
      .values({
        email: `candidate_${id}@example.test`,
        username: `candidate_${id}`,
        candidateVerifiedAt: NOW,
      })
      .returning({ id: users.id });

    return { ...tenant, candidateUserId: candidate!.id };
  };

  const registrationsFor = async (tx: Tx, candidateUserId: string) =>
    tx
      .select({ id: competitionRegistrations.id })
      .from(competitionRegistrations)
      .where(eq(competitionRegistrations.studentId, candidateUserId));

  it("records the payment, its deadline and its instructions snapshot in one go", async () => {
    // The positive control. Without it every refusal below would also pass against a gate that
    // refused unconditionally.
    await inRollback(async (tx) => {
      const fixture = await seedRegisterable(tx, {
        verified: true,
        withInstructions: true,
        feeAmount: 150_000,
      });
      const { createIndividualRegistration } = await import(
        "@/server/registrations/registration-service"
      );

      const registration = await createIndividualRegistration(
        fixture.candidateUserId,
        fixture.competitionId,
        tx as never,
        NOW,
      );

      const [payment] = await tx
        .select()
        .from(financePayments)
        .where(eq(financePayments.competitionRegistrationId, registration.id));

      expect(payment, "a priced registration was created with no payment").toBeDefined();
      expect(payment!.grossAmount).toBe(150_000);
      expect(payment!.origin).toBe("manual_transfer");
      // The manual lane splits nothing: the payer transfers the whole amount to the organiser.
      expect(payment!.platformFeeAmount).toBe(0);
      expect(payment!.institutionNetAmount).toBe(150_000);
      // Three days from registration, which lands before registration closes and so is not clamped.
      expect(payment!.dueAt?.toISOString()).toBe("2026-08-13T00:00:00.000Z");

      const [snapshot] = await tx
        .select()
        .from(financePaymentInstructionSnapshots)
        .where(eq(financePaymentInstructionSnapshots.paymentId, payment!.id));

      expect(snapshot, "the payer was given no record of where to send the money").toBeDefined();
      expect(snapshot!.accountNumber).toBe("1234567890");
      // Same transaction, so both rows read one clock. Equality of instants is not by itself proof
      // of atomicity — that is asserted separately, by removing the snapshot table.
      expect(snapshot!.capturedAt.toISOString()).toBe(payment!.createdAt.toISOString());
    });
  });

  it("REFUSES when the institution is unverified, and registers nobody", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedRegisterable(tx, {
        verified: false,
        withInstructions: true,
        feeAmount: 150_000,
      });
      const { createIndividualRegistration } = await import(
        "@/server/registrations/registration-service"
      );

      await expect(
        createIndividualRegistration(
          fixture.candidateUserId,
          fixture.competitionId,
          tx as never,
          NOW,
        ),
      ).rejects.toMatchObject({ code: "registration_payment_unavailable" });

      expect(
        await registrationsFor(tx, fixture.candidateUserId),
        "the candidate is registered for a competition that could not charge them",
      ).toHaveLength(0);
    });
  });

  it("REFUSES when the institution has published no account, and registers nobody", async () => {
    // A separate guard from verification, and a separately reachable one: a verified institution
    // that never filled the instructions form would otherwise take a registration and leave the
    // candidate owing money with no account to send it to.
    await inRollback(async (tx) => {
      const fixture = await seedRegisterable(tx, {
        verified: true,
        withInstructions: false,
        feeAmount: 150_000,
      });
      const { createIndividualRegistration } = await import(
        "@/server/registrations/registration-service"
      );

      await expect(
        createIndividualRegistration(
          fixture.candidateUserId,
          fixture.competitionId,
          tx as never,
          NOW,
        ),
      ).rejects.toMatchObject({ code: "registration_payment_unavailable" });

      expect(
        await registrationsFor(tx, fixture.candidateUserId),
        "the candidate is registered but has nowhere to pay",
      ).toHaveLength(0);
    });
  });

  it("lets a FREE competition register with no payment row and neither guard applied", async () => {
    // Verification gates the right to CHARGE, never the right to run a competition. This fixture
    // fails BOTH guards — unverified, no account — and must still register, because a free
    // competition asks nobody for money.
    await inRollback(async (tx) => {
      const fixture = await seedRegisterable(tx, {
        verified: false,
        withInstructions: false,
        feeAmount: null,
      });
      const { createIndividualRegistration } = await import(
        "@/server/registrations/registration-service"
      );

      const registration = await createIndividualRegistration(
        fixture.candidateUserId,
        fixture.competitionId,
        tx as never,
        NOW,
      );

      expect(registration.status).toBe("confirmed");

      const payments = await tx
        .select({ id: financePayments.id })
        .from(financePayments)
        .where(eq(financePayments.competitionRegistrationId, registration.id));

      // Not a zero-gross row — none at all. A free registration has no debt to record.
      expect(payments, "a free registration recorded a payment").toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PAYMENT DEADLINE LAPSING.
//
// The sweep ends registrations nobody paid for. What it must NOT do is end one belonging to a
// candidate who transferred real money — so most of these tests are about when it declines.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(skipWithoutDatabase)("the payment expiry sweep", () => {
  // DUE is 2026-08-13; sweeping from here is a day past it.
  const AFTER_DEADLINE = new Date("2026-08-14T00:00:00.000Z");

  const sweep = async (tx: Tx, at: Date = AFTER_DEADLINE) => {
    const { sweepExpiredPayments } = await import("@/server/finance/payment-expiry-service");
    return sweepExpiredPayments(at, tx as never);
  };

  const registrationStatus = async (tx: Tx, registrationId: string) => {
    const [row] = await tx
      .select({
        status: competitionRegistrations.status,
        reason: competitionRegistrations.cancellationReason,
      })
      .from(competitionRegistrations)
      .where(eq(competitionRegistrations.id, registrationId));
    return row!;
  };

  const expiredEventsFor = async (tx: Tx, paymentId: string) =>
    tx
      .select({ id: financePaymentEvents.id })
      .from(financePaymentEvents)
      .where(
        and(
          eq(financePaymentEvents.paymentId, paymentId),
          eq(financePaymentEvents.eventType, "expired"),
        ),
      );

  it("ends an unpaid registration and marks it separably from a withdrawal", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const result = await sweep(tx);

      expect(result.expired.map((o) => o.paymentId)).toContain(paymentId);
      expect(await expiredEventsFor(tx, paymentId)).toHaveLength(1);

      const registration = await registrationStatus(tx, fixture.registrationId);
      expect(registration.status).toBe("cancelled");
      // A distinct sentinel, not prose. Every later report has to separate "the candidate withdrew"
      // from "nobody paid", and a free-text sentence cannot be filtered on.
      expect(registration.reason).toBe("payment_deadline_expired");
    });
  });

  it("SUSPENDS expiry while a bukti transfer is awaiting review", async () => {
    // The rule that matters most here. The deadline governs SUBMISSION, never the organiser's
    // verdict — a candidate who transferred and uploaded in time must never be cancelled because
    // the organiser was slow. Delete the pending-proof re-check and this test fails.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      await seedProof(tx, fixture, paymentId);

      const result = await sweep(tx);

      expect(result.expired).toHaveLength(0);
      expect(await expiredEventsFor(tx, paymentId)).toHaveLength(0);
      expect((await registrationStatus(tx, fixture.registrationId)).status).toBe("confirmed");
    });
  });

  it("leaves a payment that already succeeded alone", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await tx.insert(financePaymentEvents).values({
        paymentId,
        eventType: "succeeded",
        occurredAt: NOW,
        amount: 1_000_000,
        currency: "IDR",
        actorType: "system",
        idempotencyKey: `mn:succeeded:${paymentId}:0`,
      });

      const result = await sweep(tx);

      expect(result.expired).toHaveLength(0);
      expect((await registrationStatus(tx, fixture.registrationId)).status).toBe("confirmed");
    });
  });

  it("leaves a payment whose deadline has not passed alone", async () => {
    // The negative control. Without it every assertion above would also pass against a sweep that
    // expired everything it could reach.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const result = await sweep(tx, new Date("2026-08-11T00:00:00.000Z"));

      expect(result.expired).toHaveLength(0);
      expect(await expiredEventsFor(tx, paymentId)).toHaveLength(0);
    });
  });

  it("writes ONE expired event however many times it sweeps", async () => {
    // The sweep is scheduled, so the same overdue payment is revisited by retries, overlapping
    // runs and redeploys. A second visit must collapse onto the first event, not append another to
    // a ledger with no delete path.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await sweep(tx);
      await sweep(tx);
      await sweep(tx);

      expect(await expiredEventsFor(tx, paymentId)).toHaveLength(1);
    });
  });

  it("ends EVERY member's registration when a team's payment lapses", async () => {
    // A team pays once, so a lapsed team payment ends the whole roster. Leaving three members
    // "registered" for a competition their team never paid for would be worse than cancelling them.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const [team] = await tx
        .insert(teams)
        .values({
          competitionId: fixture.competitionId,
          captainId: fixture.userId,
          name: `Tim ${uniqueSuffix()}`,
          status: "submitted",
        })
        .returning({ id: teams.id });

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

        const [registration] = await tx
          .insert(competitionRegistrations)
          .values({
            competitionId: fixture.competitionId,
            studentId: member!.id,
            teamId: team!.id,
            registrationType: "team",
            status: "confirmed",
          })
          .returning({ id: competitionRegistrations.id });

        memberIds.push(registration!.id);
      }

      // One payment for the whole team, anchored on the first member's row.
      await seedManualPayment(tx, fixture, { competitionRegistrationId: memberIds[0]! });

      const result = await sweep(tx);

      expect(result.expired).toHaveLength(1);
      expect(result.expired[0]!.registrationsCancelled).toBe(3);

      for (const registrationId of memberIds) {
        expect((await registrationStatus(tx, registrationId)).status).toBe("cancelled");
      }
    });
  });
});

describe.skipIf(skipWithoutDatabase)("what a candidate is told about money they owe", () => {
  const view = async (tx: Tx, registrationId: string, userId: string) => {
    const { loadCandidatePaymentView } = await import("@/server/finance/candidate-payment-view");
    return loadCandidatePaymentView(registrationId, userId, tx as never);
  };

  /** The fixture's own registration converted to a team, plus one more member. */
  const seedTeamOf = async (tx: Tx, fixture: Fixture) => {
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

    await tx
      .update(competitionRegistrations)
      .set({ registrationType: "team", teamId: team!.id })
      .where(eq(competitionRegistrations.id, fixture.registrationId));

    const [member] = await tx
      .insert(users)
      .values({
        email: `mate_${id}@example.test`,
        username: `mate_${id}`,
        candidateVerifiedAt: NOW,
      })
      .returning({ id: users.id });

    const [memberRegistration] = await tx
      .insert(competitionRegistrations)
      .values({
        competitionId: fixture.competitionId,
        studentId: member!.id,
        registrationType: "team",
        teamId: team!.id,
      })
      .returning({ id: competitionRegistrations.id });

    return { memberUserId: member!.id, memberRegistrationId: memberRegistration!.id };
  };

  it("shows the payer what is owed, where to send it, and by when", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      await tx.insert(financePaymentInstructionSnapshots).values({
        paymentId,
        bankName: "Bank Contoh",
        accountNumber: "1234567890",
        accountHolderName: "Panitia Lomba",
      });

      const result = await view(tx, fixture.registrationId, fixture.userId);

      expect(result).not.toBeNull();
      expect(result!.grossAmount).toBe(1_000_000);
      expect(result!.currency).toBe("IDR");
      expect(result!.dueAt?.toISOString()).toBe(DUE.toISOString());
      expect(result!.instructions?.accountNumber).toBe("1234567890");
      expect(result!.isPayer).toBe(true);
      expect(result!.canSubmitProof).toBe(true);
    });
  });

  it("reads the SNAPSHOT, so an organiser changing banks cannot repoint a payer mid-transfer", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      await tx.insert(financePaymentInstructionSnapshots).values({
        paymentId,
        bankName: "Bank Contoh",
        accountNumber: "1234567890",
        accountHolderName: "Panitia Lomba",
      });

      // The institution moves its account AFTER the payment was created.
      await tx
        .update(institutionPaymentInstructions)
        .set({ accountNumber: "9999999999", bankName: "Bank Lain" })
        .where(eq(institutionPaymentInstructions.institutionId, fixture.institutionId));

      const result = await view(tx, fixture.registrationId, fixture.userId);

      // The payer still sees the account they agreed to pay. Reading the live row here would send
      // real money to an account the payer never saw, and the platform would have moved it.
      expect(result!.instructions?.accountNumber).toBe("1234567890");
      expect(result!.instructions?.bankName).toBe("Bank Contoh");
    });
  });

  it("shows EVERY team member the team's one payment, not just the captain", async () => {
    // A team pays once, anchored on the captain's row. Scoping this read to the caller's own
    // registration would tell three of four members their team owes nothing.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await seedManualPayment(tx, fixture);
      const { memberUserId, memberRegistrationId } = await seedTeamOf(tx, fixture);

      const result = await view(tx, memberRegistrationId, memberUserId);

      expect(result).not.toBeNull();
      expect(result!.grossAmount).toBe(1_000_000);
    });
  });

  it("answers a teammate who asks using the CAPTAIN'S registration id", async () => {
    // The scope is asked of the payment GROUP, not of the registration that was named, and this is
    // the only test that can tell the two apart: a member passing their OWN id is matched by either
    // version. Narrow the WHERE to `id = registrationId` and this goes red while every other test
    // here stays green — which is exactly how the weaker scope would have shipped.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await seedManualPayment(tx, fixture);
      const { memberUserId } = await seedTeamOf(tx, fixture);

      const result = await view(tx, fixture.registrationId, memberUserId);

      expect(result).not.toBeNull();
      expect(result!.isPayer).toBe(false);
    });
  });

  it("WITHHOLDS the upload affordance from a teammate who is not the payer", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await seedManualPayment(tx, fixture);
      const { memberUserId, memberRegistrationId } = await seedTeamOf(tx, fixture);

      const result = await view(tx, memberRegistrationId, memberUserId);

      // Withheld, not rendered-and-refused: `submitManualPaymentProof` filters on the payer, so a
      // control offered here could only ever fail. The teammate still sees what is owed.
      expect(result!.isPayer).toBe(false);
      expect(result!.canSubmitProof).toBe(false);
      expect(result!.canResubmitProof).toBe(false);
    });
  });

  it("tells a candidate from another institution nothing at all", async () => {
    // The cross-tenant negative, against a SECOND real institution rather than a contrived id. A
    // single-tenant fixture cannot catch a missing scope: every id it has belongs to the same
    // tenant, so an unscoped query looks correct.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await seedManualPayment(tx, fixture);

      const result = await view(tx, fixture.registrationId, fixture.other.userId);

      expect(result).toBeNull();
    });
  });

  it("tells a candidate nothing about a registration that is not theirs in their own tenant", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await seedManualPayment(tx, fixture);
      const { memberUserId } = await seedTeamOf(tx, fixture);

      // A real user, a real payment, but a registration in a group they do not belong to. Seeded by
      // pointing the other tenant's registration at this user's id would be a contrivance; instead
      // the teammate asks about the OTHER tenant's registration.
      const result = await view(tx, fixture.other.registrationId, memberUserId);

      expect(result).toBeNull();
    });
  });

  it("says nothing to pay for a free competition", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      // A zero-gross row: a free registration that happens to have been recorded. Row existence is
      // not the predicate.
      await seedManualPayment(tx, fixture, { grossAmount: 0, institutionNetAmount: 0 });

      expect(await view(tx, fixture.registrationId, fixture.userId)).toBeNull();
    });
  });

  it("offers resubmission after a rejection the organiser left open, and withholds it after a bar", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId, {
        status: "rejected",
        rejectionReason: "Nominal tidak cocok",
        reviewerUserId: fixture.userId,
        reviewedAt: NOW,
        resubmissionAllowed: true,
      });

      const open = await view(tx, fixture.registrationId, fixture.userId);
      expect(open!.canResubmitProof).toBe(true);
      expect(open!.canSubmitProof).toBe(false);

      await tx
        .update(financeManualPaymentProofs)
        .set({ resubmissionAllowed: false })
        .where(eq(financeManualPaymentProofs.id, proofId));

      const barred = await view(tx, fixture.registrationId, fixture.userId);
      expect(barred!.canResubmitProof).toBe(false);
    });
  });

  it("offers resubmission after a VOID even though the organiser barred it", async () => {
    // The void arm ignores the bar deliberately: the bar was set against the organiser's own
    // rejection, and a void is platform_ops correcting something else. Without this the payer is
    // stranded — nothing in flight, no way to refile, and the deadline still running.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      await seedProof(tx, fixture, paymentId, {
        status: "voided",
        reviewerUserId: fixture.userId,
        reviewedAt: NOW,
        resubmissionAllowed: false,
      });

      const result = await view(tx, fixture.registrationId, fixture.userId);

      expect(result!.canResubmitProof).toBe(true);
    });
  });

  it("WITHHOLDS everything once the payment has succeeded", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      const { appendPaymentEvent } = await import("@/server/finance/payment-service");
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

      const result = await view(tx, fixture.registrationId, fixture.userId);

      expect(result!.status).toBe("succeeded");
      expect(result!.canSubmitProof).toBe(false);
      expect(result!.canResubmitProof).toBe(false);
    });
  });

  it("WITHHOLDS everything once the registration has been cancelled", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await seedManualPayment(tx, fixture);
      await tx
        .update(competitionRegistrations)
        .set({ status: "cancelled", cancelledAt: NOW, cancellationReason: "payment_deadline_expired" })
        .where(eq(competitionRegistrations.id, fixture.registrationId));

      const result = await view(tx, fixture.registrationId, fixture.userId);

      expect(result!.canSubmitProof).toBe(false);
    });
  });
});

// THE ORGANISER REVIEW SURFACE, from both sides of the tenant boundary.
//
// Every negative here is exercised in BOTH directions with two DIFFERENT outsiders, because one
// standing in for both cannot distinguish "the scope works" from "this particular fixture happens
// not to match". The two directions are also not symmetric in practice: an admin of A reaching for
// D's proof is the accidental case (a stale link, a copied id), and an admin of D reaching for A's
// proof is the deliberate one.
describe.skipIf(skipWithoutDatabase)("organiser payment review across tenants (real database)", () => {
  const paymentValuesFor = (fixture: Fixture, tenant: Tenant) =>
    manualPaymentValues(fixture, {
      payerUserId: tenant.userId,
      receivingInstitutionId: tenant.institutionId,
      competitionRegistrationId: tenant.registrationId,
    });

  /** A manual payment plus one pending bukti transfer, owned by `tenant`. */
  const seedPendingProof = async (
    tx: Tx,
    fixture: Fixture,
    tenant: Tenant,
  ): Promise<{ paymentId: string; proofId: string }> => {
    const [payment] = await tx
      .insert(financePayments)
      .values(paymentValuesFor(fixture, tenant))
      .returning({ id: financePayments.id });

    const [proof] = await tx
      .insert(financeManualPaymentProofs)
      .values({
        paymentId: payment!.id,
        competitionId: tenant.competitionId,
        submittedByUserId: tenant.userId,
        status: "pending_review" as const,
        r2Key: `payment-proofs/${tenant.competitionId}/${payment!.id}/file`,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 1024,
        contentType: "image/jpeg",
      })
      .returning({ id: financeManualPaymentProofs.id });

    return { paymentId: payment!.id, proofId: proof!.id };
  };

  const statusOf = async (tx: Tx, proofId: string): Promise<string> => {
    const [row] = await tx
      .select({ status: financeManualPaymentProofs.status })
      .from(financeManualPaymentProofs)
      .where(eq(financeManualPaymentProofs.id, proofId))
      .limit(1);
    return row!.status;
  };

  describe("loadOrganiserPaymentQueue", () => {
    it("shows an institution its OWN competition's proofs", async () => {
      // The positive that makes the two negatives below mean something. Without it they would pass
      // against a function that returns an empty array unconditionally.
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { proofId } = await seedPendingProof(tx, fixture, fixture);
        const { loadOrganiserPaymentQueue } = await import(
          "@/server/finance/organiser-payment-review"
        );

        const queue = await loadOrganiserPaymentQueue(
          fixture.institutionId,
          fixture.competitionId,
          tx as unknown as Database,
        );

        expect(queue.map((row) => row.proofId)).toEqual([proofId]);
      });
    });

    it("shows an admin of A nothing when they ask for D's competition", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        await seedPendingProof(tx, fixture, fixture.other);
        const { loadOrganiserPaymentQueue } = await import(
          "@/server/finance/organiser-payment-review"
        );

        const queue = await loadOrganiserPaymentQueue(
          fixture.institutionId,
          fixture.other.competitionId,
          tx as unknown as Database,
        );

        expect(queue).toEqual([]);
      });
    });

    it("shows an admin of D nothing when they ask for A's competition", async () => {
      // The other direction, with the other outsider. Not the same assertion twice: this one fails
      // if the scope is written against the PROOF's institution rather than the competition's.
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        await seedPendingProof(tx, fixture, fixture);
        const { loadOrganiserPaymentQueue } = await import(
          "@/server/finance/organiser-payment-review"
        );

        const queue = await loadOrganiserPaymentQueue(
          fixture.other.institutionId,
          fixture.competitionId,
          tx as unknown as Database,
        );

        expect(queue).toEqual([]);
      });
    });

    it("never carries the payer's email, only a display name", async () => {
      // An organiser reviewing a transfer needs to know whose it is, not how to reach them off
      // platform. Asserted on the serialised row so a future column addition cannot slip one in.
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        await seedPendingProof(tx, fixture, fixture);
        const { loadOrganiserPaymentQueue } = await import(
          "@/server/finance/organiser-payment-review"
        );

        const [row] = await loadOrganiserPaymentQueue(
          fixture.institutionId,
          fixture.competitionId,
          tx as unknown as Database,
        );

        expect(JSON.stringify(row)).not.toContain("@example.test");
        expect(row!.payer.displayName).toContain("manual_");
      });
    });
  });

  describe("verifyManualPaymentProof", () => {
    it("verifies a proof on the institution's own competition", async () => {
      // The positive. Both negatives below assert a refusal, and a refusal proves nothing unless
      // the same call succeeds when it should.
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { proofId } = await seedPendingProof(tx, fixture, fixture);
        const { verifyManualPaymentProof } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        await verifyManualPaymentProof(
          fixture.institutionId,
          fixture.userId,
          proofId,
          tx as unknown as Database,
          NOW,
        );

        expect(await statusOf(tx, proofId)).toBe("verified");
      });
    });

    it("REFUSES an admin of A verifying D's proof, and leaves the proof untouched", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { proofId } = await seedPendingProof(tx, fixture, fixture.other);
        const { verifyManualPaymentProof, ManualProofError } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        await expect(
          verifyManualPaymentProof(
            fixture.institutionId,
            fixture.userId,
            proofId,
            tx as unknown as Database,
            NOW,
          ),
        ).rejects.toBeInstanceOf(ManualProofError);

        // The post-condition, not just the throw. A guard that refuses AFTER writing is not a guard.
        expect(await statusOf(tx, proofId)).toBe("pending_review");
      });
    });

    it("REFUSES an admin of D verifying A's proof, and leaves the proof untouched", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { proofId } = await seedPendingProof(tx, fixture, fixture);
        const { verifyManualPaymentProof, ManualProofError } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        await expect(
          verifyManualPaymentProof(
            fixture.other.institutionId,
            fixture.other.userId,
            proofId,
            tx as unknown as Database,
            NOW,
          ),
        ).rejects.toBeInstanceOf(ManualProofError);

        expect(await statusOf(tx, proofId)).toBe("pending_review");
      });
    });

    it("writes NO ledger event and NO fee accrual for the payment when the verify is refused", async () => {
      // The consequence that makes this boundary worth guarding: verifying is not a status change,
      // it is a declaration that money arrived — a `succeeded` event and a platform fee accrual,
      // both in an append-only ledger with no delete.
      //
      // Scoped to the PAYMENT, not to the outsider's institution. A first version asked whether an
      // accrual existed against `other.institutionId` and stayed green with the guard removed, for
      // a reason that had nothing to do with the guard: `owingInstitutionId` is copied from the
      // payment's `receivingInstitutionId`, so an accrual can never carry the reviewer's id and
      // that query could never return a row either way.
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { paymentId, proofId } = await seedPendingProof(tx, fixture, fixture);
        const { verifyManualPaymentProof } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        await verifyManualPaymentProof(
          fixture.other.institutionId,
          fixture.other.userId,
          proofId,
          tx as unknown as Database,
          NOW,
        ).catch(() => undefined);

        const accruals = await tx
          .select({ id: financeFeeAccruals.id })
          .from(financeFeeAccruals)
          .where(eq(financeFeeAccruals.paymentId, paymentId));

        const events = await tx
          .select({ type: financePaymentEvents.eventType })
          .from(financePaymentEvents)
          .where(eq(financePaymentEvents.paymentId, paymentId));

        expect(accruals).toEqual([]);
        expect(events.map((event) => event.type)).not.toContain("succeeded");
      });
    });

    it("refuses a foreign PENDING proof and a foreign SETTLED proof INDISTINGUISHABLY", async () => {
      // THE MOVE DETECTOR, and the reason it takes this shape rather than an assertion about the
      // row: the service does its work inside a transaction, so a tenant check moved BELOW the
      // write still rolls the write back, and every post-state assertion above stays green. What a
      // move cannot preserve is this — with the scope inside the CAS's WHERE, a foreign proof
      // matches no row whatever state it is in, so both cases return the identical "not pending"
      // refusal. Move the scope to a check after the update and the pending one now reaches that
      // check and answers differently from the settled one, which both fails this test and hands an
      // outsider an oracle for whether a proof exists and is awaiting review.
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const pending = await seedPendingProof(tx, fixture, fixture);
        const settled = await seedPendingProof(tx, fixture, fixture);

        await tx
          .update(financeManualPaymentProofs)
          .set({ status: "verified", reviewerUserId: fixture.userId, reviewedAt: NOW })
          .where(eq(financeManualPaymentProofs.id, settled.proofId));

        const { verifyManualPaymentProof, ManualProofError } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        const refusalFor = async (proofId: string) => {
          try {
            await verifyManualPaymentProof(
              fixture.other.institutionId,
              fixture.other.userId,
              proofId,
              tx as unknown as Database,
              NOW,
            );
            return null;
          } catch (error) {
            if (!(error instanceof ManualProofError)) throw error;
            return { code: error.code, status: error.status, message: error.message };
          }
        };

        const onPending = await refusalFor(pending.proofId);
        const onSettled = await refusalFor(settled.proofId);

        expect(onPending).not.toBeNull();
        expect(onPending).toEqual(onSettled);
      });
    });
  });

  describe("generateManualProofViewUrl", () => {
    const accessRowsFor = async (tx: Tx, institutionId: string) =>
      tx
        .select({ id: institutionAuditLogs.id })
        .from(institutionAuditLogs)
        .where(
          and(
            eq(institutionAuditLogs.institutionId, institutionId),
            eq(institutionAuditLogs.action, "payment_proof.file_accessed"),
          ),
        );

    it("gets PAST the boundary for the institution's own proof", async () => {
      // The positive, stated as what it can honestly claim. Minting the URL needs object storage,
      // which a local checkout may not have configured, so this asserts the boundary was cleared
      // rather than that a URL came back: any refusal here must NOT be the not-found the tenant
      // scope raises. Without this the negative below would pass against a function that throws
      // unconditionally.
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { proofId } = await seedPendingProof(tx, fixture, fixture);
        const { generateManualProofViewUrl } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        const outcome = await generateManualProofViewUrl(
          fixture.institutionId,
          fixture.userId,
          proofId,
          tx as unknown as Database,
        ).catch((error: unknown) => error);

        const code = outcome instanceof Error ? (outcome as { code?: string }).code : null;
        expect(code).not.toBe("manual_proof_not_found");
      });
    });

    it("RECORDS NO ACCESS when an outsider asks to view a proof", async () => {
      // An audit row for a refused read is worse than none: it puts an access in the record that
      // never happened, against an organiser who was turned away.
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { proofId } = await seedPendingProof(tx, fixture, fixture);
        const { generateManualProofViewUrl } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        await generateManualProofViewUrl(
          fixture.other.institutionId,
          fixture.other.userId,
          proofId,
          tx as unknown as Database,
        ).catch(() => undefined);

        expect(await accessRowsFor(tx, fixture.other.institutionId)).toEqual([]);
        // Nor against the owning institution — a refused outsider must leave no trace anywhere,
        // least of all one that reads as the owner having opened their own file.
        expect(await accessRowsFor(tx, fixture.institutionId)).toEqual([]);
      });
    });
  });

  describe("rejectManualPaymentProof", () => {
    it("REFUSES an admin of A rejecting D's proof, and leaves the proof untouched", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { proofId } = await seedPendingProof(tx, fixture, fixture.other);
        const { rejectManualPaymentProof, ManualProofError } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        await expect(
          rejectManualPaymentProof(
            fixture.institutionId,
            fixture.userId,
            proofId,
            "Nominal tidak cocok",
            true,
            tx as unknown as Database,
            NOW,
          ),
        ).rejects.toBeInstanceOf(ManualProofError);

        expect(await statusOf(tx, proofId)).toBe("pending_review");
      });
    });

    it("REFUSES an admin of D rejecting A's proof, and leaves the proof untouched", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { proofId } = await seedPendingProof(tx, fixture, fixture);
        const { rejectManualPaymentProof, ManualProofError } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        await expect(
          rejectManualPaymentProof(
            fixture.other.institutionId,
            fixture.other.userId,
            proofId,
            "Nominal tidak cocok",
            true,
            tx as unknown as Database,
            NOW,
          ),
        ).rejects.toBeInstanceOf(ManualProofError);

        expect(await statusOf(tx, proofId)).toBe("pending_review");
      });
    });

    it("refuses a foreign PENDING proof and a foreign SETTLED proof INDISTINGUISHABLY", async () => {
      // The move detector for the reject path, and it exists because a classification pass over
      // every guard in this lane found this one had only half its pair. Removing reject's tenant
      // scope turned tests red; MOVING it below the write compiled and left all fourteen green,
      // exactly as the verify path did before its own detector was written.
      //
      // Same reasoning as the verify case: the service works inside a transaction, so a check that
      // throws after the update rolls the update back and every post-state assertion still passes.
      // What a move cannot preserve is the refusal being identical whatever state the foreign proof
      // is in — the moved check answers the pending one differently, which fails here and hands an
      // outsider an oracle for whether a proof exists and awaits review.
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const pending = await seedPendingProof(tx, fixture, fixture);
        const settled = await seedPendingProof(tx, fixture, fixture);

        await tx
          .update(financeManualPaymentProofs)
          .set({ status: "verified", reviewerUserId: fixture.userId, reviewedAt: NOW })
          .where(eq(financeManualPaymentProofs.id, settled.proofId));

        const { rejectManualPaymentProof, ManualProofError } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        const refusalFor = async (proofId: string) => {
          try {
            await rejectManualPaymentProof(
              fixture.other.institutionId,
              fixture.other.userId,
              proofId,
              "Nominal tidak cocok",
              true,
              tx as unknown as Database,
              NOW,
            );
            return null;
          } catch (error) {
            if (!(error instanceof ManualProofError)) throw error;
            return { code: error.code, status: error.status, message: error.message };
          }
        };

        const onPending = await refusalFor(pending.proofId);
        const onSettled = await refusalFor(settled.proofId);

        expect(onPending).not.toBeNull();
        expect(onPending).toEqual(onSettled);
      });
    });

    it("rejects a proof on the institution's own competition", async () => {
      await inRollback(async (tx) => {
        const fixture = await seedFixture(tx);
        const { proofId } = await seedPendingProof(tx, fixture, fixture);
        const { rejectManualPaymentProof } = await import(
          "@/server/finance/manual-payment-proof-service"
        );

        await rejectManualPaymentProof(
          fixture.institutionId,
          fixture.userId,
          proofId,
          "Nominal tidak cocok",
          true,
          tx as unknown as Database,
          NOW,
        );

        expect(await statusOf(tx, proofId)).toBe("rejected");
      });
    });
  });
});
