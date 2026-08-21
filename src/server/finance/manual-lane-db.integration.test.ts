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

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  candidateProfiles,
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
  platformOpsAuditLogs,
  teams,
  users,
} from "@/server/db/schema";

// THE ONLY SEAM IN THIS FILE, and it is drawn at the queue rather than at the service.
//
// Everything below it runs for real — the service, its transaction, its reads. What is replaced is
// the BullMQ write, because observing "what would be announced" is the assertion and a real queue
// would also drag Redis into a database test. `importOriginal` is spread first so the fourteen
// other enqueue helpers this file's services reach are the real ones; replacing the module wholesale
// would leave them undefined and break tests that have nothing to do with notifications.
const { mockEnqueuePaymentProofSubmitted, mockEnqueuePaymentOutcome } = vi.hoisted(() => ({
  mockEnqueuePaymentProofSubmitted: vi.fn(),
  mockEnqueuePaymentOutcome: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  enqueuePaymentProofSubmitted: mockEnqueuePaymentProofSubmitted,
  enqueuePaymentOutcome: mockEnqueuePaymentOutcome,
}));

beforeEach(() => {
  mockEnqueuePaymentProofSubmitted.mockReset();
  mockEnqueuePaymentOutcome.mockReset();
});

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

  it("tells a MATRIX-BLOCKED organiser nothing about the platform's pricing configuration", async () => {
    // THE CLASS A DETECTOR for the classifier's position, and the reason a post-state green on the
    // priced path is uninformative rather than reassuring.
    //
    // The transaction makes a moved WRITE harmless. It does not make the moved REFUSAL harmless.
    // The gate order exists, in the service's own words, "so nothing about the platform's pricing
    // configuration leaks to someone who is not allowed to charge at all" — move the classifier
    // below the write and gates 3 through 6 run first, so an organiser who is blocked outright
    // learns whether Lombakita has a fee rule configured, whether their institution is verified for
    // charging, and whether their instructions are published. None of that is answerable to someone
    // the matrix has already refused.
    //
    // The fixture is blocked AND unpriceable at once, so the two orderings give different answers.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await grantOwnership(tx, fixture);
      await tx
        .update(competitions)
        .set({ feeAmount: 50_000, feeCurrency: "IDR" })
        .where(eq(competitions.id, fixture.competitionId));

      // Blocked by the matrix: a bukti transfer is outstanding.
      const paymentId = await seedManualPayment(tx, fixture);
      await seedProof(tx, fixture, paymentId);

      // AND unpriceable: the only fee rule is retired out of force. Retired rather than deleted
      // because `finance_payments.fee_rule_id` references it — the payment that blocks the matrix
      // is itself what makes the row undeletable.
      await tx
        .update(financeFeeRules)
        .set({ effectiveFrom: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), effectiveTo: null })
        .where(eq(financeFeeRules.id, fixture.feeRuleId));

      await expect(priceIt(tx, fixture, 90_000)).rejects.toMatchObject({
        // The matrix refusal, not `fee_rule_not_in_force`. Under a moved classifier this is the
        // latter, which answers a question the caller was never entitled to ask.
        code: "competition_fee_change_blocked_payment_in_flight",
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
        // Anchored to REAL time, not to the frozen `NOW` the payment assertions use. Publish
        // validation compares `registrationEndAt` against the wall clock and takes no injectable
        // instant, so a fixture dated from `NOW` is a timer: it passes when written and starts
        // failing on the day real time overtakes it.
        registrationStartAt: new Date(Date.now() + 1 * 86_400_000),
        registrationEndAt: new Date(Date.now() + 10 * 86_400_000),
        participantConfirmationAt: new Date(Date.now() + 12 * 86_400_000),
        eventStartAt: new Date(Date.now() + 20 * 86_400_000),
        eventEndAt: new Date(Date.now() + 21 * 86_400_000),
        resultAnnouncementAt: new Date(Date.now() + 25 * 86_400_000),
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

describe.skipIf(skipWithoutDatabase)("the cancel affordance the page offers (real database)", () => {
  // DEC-0131's third predicate, asked the way the REGISTRATION PAGE asks it.
  //
  // The two cancel services are proven elsewhere. What is proven here is that the surface deciding
  // whether to OFFER the control reaches the same answer — a page that derived this independently
  // would eventually render a control the server refuses, and the refusal would be the candidate's
  // first news of the rule.
  //
  // Every proof here is submitted through `submitManualPaymentProof`, the real production path, not
  // inserted. A hand-built proof row proves the predicate; only the real path proves the wiring.

  const resolve = async (
    tx: Tx,
    input: {
      individualRegistration?: { id: string; status: string } | null;
      team?: { id: string; status: string } | null;
    },
  ) => {
    const { resolveCancelAffordanceState } = await import("@/server/finance/cancel-affordance");
    return resolveCancelAffordanceState(
      {
        individualRegistration: input.individualRegistration ?? null,
        team: input.team ?? null,
      },
      tx as never,
    );
  };

  const submitProofFor = async (tx: Tx, fixture: Fixture, paymentId: string) => {
    const { submitManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return submitManualPaymentProof(
      {
        paymentId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      },
      tx as never,
    );
  };

  const seedSubmittedTeam = async (tx: Tx, fixture: Fixture) => {
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

    const [mate] = await tx
      .insert(users)
      .values({ email: `mate_${id}@example.test`, username: `mate_${id}`, candidateVerifiedAt: NOW })
      .returning({ id: users.id });

    await tx.insert(competitionRegistrations).values({
      competitionId: fixture.competitionId,
      studentId: mate!.id,
      registrationType: "team",
      teamId: team!.id,
    });

    return { teamId: team!.id };
  };

  it("OFFERS both controls when nothing has been submitted", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { teamId } = await seedSubmittedTeam(tx, fixture);
      await seedManualPayment(tx, fixture);

      // A priced payment with no proof against it is the common case, and it must not close
      // anything: the candidate owes money and has sent none, so leaving costs nobody anything.
      expect(
        await resolve(tx, {
          individualRegistration: { id: fixture.registrationId, status: "confirmed" },
          team: { id: teamId, status: "submitted" },
        }),
      ).toEqual({ individualCancellationClosed: false, teamCancellationClosed: false });
    });
  });

  it("WITHHOLDS the individual control once a bukti transfer is submitted through the real path", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      await submitProofFor(tx, fixture, paymentId);

      const state = await resolve(tx, {
        individualRegistration: { id: fixture.registrationId, status: "confirmed" },
      });

      expect(state.individualCancellationClosed).toBe(true);
    });
  });

  it("STILL withholds after the organiser REJECTS the proof", async () => {
    // The part of DEC-0131 that looks wrong and is not. A rejection means the organiser was not
    // satisfied by the evidence; it does not establish that no money moved, and the platform — which
    // never touches this money — is in no position to rule that it did not. This is the assertion
    // that separates the third predicate from payment-in-flight, which would hand the right to
    // cancel BACK at this exact moment.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProofFor(tx, fixture, paymentId);

      const { rejectManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      await rejectManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        "nominal tidak sesuai",
        true,
        tx as never,
        NOW,
      );

      expect(
        (
          await resolve(tx, {
            individualRegistration: { id: fixture.registrationId, status: "confirmed" },
          })
        ).individualCancellationClosed,
      ).toBe(true);
    });
  });

  it("WITHHOLDS the team control from a proof anchored on ONE member's row", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { teamId } = await seedSubmittedTeam(tx, fixture);
      const paymentId = await seedManualPayment(tx, fixture);
      await submitProofFor(tx, fixture, paymentId);

      // The payment is anchored on the captain's row; the team answer must still be closed, because
      // a team pays once and every member's row shares that payment.
      expect(
        (await resolve(tx, { team: { id: teamId, status: "submitted" } })).teamCancellationClosed,
      ).toBe(true);
    });
  });

  it("does NOT cross the two answers — an individual proof leaves the team control offered", async () => {
    // THE SWAP DETECTOR. Both fields are booleans of the same type computed side by side, so a
    // crossed assignment type-checks and every single-mode test above stays green. This is the only
    // assertion that fails on it, and it needs a candidate holding BOTH an individual registration
    // with a proof and a separate team with none.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      await submitProofFor(tx, fixture, paymentId);

      const id = uniqueSuffix();
      const [mate] = await tx
        .insert(users)
        .values({
          email: `solo_${id}@example.test`,
          username: `solo_${id}`,
          candidateVerifiedAt: NOW,
        })
        .returning({ id: users.id });
      const [team] = await tx
        .insert(teams)
        .values({
          competitionId: fixture.competitionId,
          captainId: mate!.id,
          name: `Tim ${id}`,
          status: "submitted",
        })
        .returning({ id: teams.id });
      await tx.insert(competitionRegistrations).values({
        competitionId: fixture.competitionId,
        studentId: mate!.id,
        registrationType: "team",
        teamId: team!.id,
      });

      expect(
        await resolve(tx, {
          individualRegistration: { id: fixture.registrationId, status: "confirmed" },
          team: { id: team!.id, status: "submitted" },
        }),
      ).toEqual({ individualCancellationClosed: true, teamCancellationClosed: false });
    });
  });

  it("asks nothing for a CANCELLED registration or a FORMING team", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { teamId } = await seedSubmittedTeam(tx, fixture);
      const paymentId = await seedManualPayment(tx, fixture);
      await submitProofFor(tx, fixture, paymentId);

      // A proof exists, so both would be closed if the status gates were dropped. They are not
      // asked, because neither state renders a cancel control to withhold.
      expect(
        await resolve(tx, {
          individualRegistration: { id: fixture.registrationId, status: "cancelled" },
          team: { id: teamId, status: "forming" },
        }),
      ).toEqual({ individualCancellationClosed: false, teamCancellationClosed: false });
    });
  });

  it("OFFERS the control on a FREE competition that happens to carry a payment row", async () => {
    // A zero-gross payment is a free registration that was recorded, not a payment. A proof filed
    // against one must not strip a free entrant's right to leave.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture, {
        grossAmount: 0,
        platformFeeAmount: 0,
        institutionNetAmount: 0,
      });
      await submitProofFor(tx, fixture, paymentId);

      expect(
        (
          await resolve(tx, {
            individualRegistration: { id: fixture.registrationId, status: "confirmed" },
          })
        ).individualCancellationClosed,
      ).toBe(false);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the cancel guards refuse BEFORE they write (real database)", () => {
  // CLASS B, and it needed a real database to be Class B at all.
  //
  // Both cancel guards sit before their write and outside its transaction, so the natural way to
  // get them wrong — running them after the transaction commits — is detectable by post-state: the
  // registration is already cancelled when the refusal is thrown. That is the assertion here.
  //
  // The existing service tests cannot make it. They run against a queued fake, so moving the guard
  // past the transaction fails them with `team_state_conflict` — a fake's response ordering, not
  // the guard's position. A probe that goes red for the wrong reason is the same defect as one that
  // stays green: neither is measuring the guard.

  const openCancellationWindow = async (tx: Tx, fixture: Fixture) => {
    await tx
      .update(competitions)
      .set({
        feeAmount: 100_000,
        feeCurrency: "IDR",
        allowCancellation: true,
        cancellationCutoffDays: 1,
        // Real time, not the frozen NOW: the cancellation window is compared against the clock.
        eventStartAt: new Date(Date.now() + 30 * 86_400_000),
      })
      .where(eq(competitions.id, fixture.competitionId));
  };

  const submitProofFor = async (tx: Tx, fixture: Fixture, paymentId: string) => {
    const { submitManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return submitManualPaymentProof(
      {
        paymentId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      },
      tx as never,
    );
  };

  const statusOf = async (tx: Tx, registrationId: string): Promise<string> => {
    const [row] = await tx
      .select({ status: competitionRegistrations.status })
      .from(competitionRegistrations)
      .where(eq(competitionRegistrations.id, registrationId))
      .limit(1);
    return row!.status;
  };

  it("REFUSES an individual cancellation and leaves the registration confirmed", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await openCancellationWindow(tx, fixture);
      const paymentId = await seedManualPayment(tx, fixture);
      await submitProofFor(tx, fixture, paymentId);

      const { cancelRegistration } = await import("@/server/registrations/registration-service");
      await expect(
        cancelRegistration(
          fixture.userId,
          fixture.competitionId,
          fixture.registrationId,
          "berubah pikiran",
          tx as never,
        ),
      ).rejects.toMatchObject({
        code: "cancellation_not_supported_for_paid",
        // The message too, not just the code. It is what the candidate reads, it is the standing
        // Indonesian-copy condition, and pinning it is what makes the refusal comparable between
        // orderings — moving this guard INSIDE the transaction is undetectable precisely because
        // the refusal is byte-identical, and that claim is only meaningful if the bytes are pinned.
        message: "Pendaftaran tidak dapat dibatalkan setelah bukti transfer dikirim",
      });

      // THE POST-STATE ASSERTION. A guard that ran after the transaction throws the same error and
      // leaves this row cancelled.
      expect(await statusOf(tx, fixture.registrationId)).toBe("confirmed");
    });
  });

  it("REFUSES a team cancellation and leaves every member's registration confirmed", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await openCancellationWindow(tx, fixture);

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

      const [mate] = await tx
        .insert(users)
        .values({
          email: `mate_${id}@example.test`,
          username: `mate_${id}`,
          candidateVerifiedAt: NOW,
        })
        .returning({ id: users.id });
      const [mateRegistration] = await tx
        .insert(competitionRegistrations)
        .values({
          competitionId: fixture.competitionId,
          studentId: mate!.id,
          registrationType: "team",
          teamId: team!.id,
        })
        .returning({ id: competitionRegistrations.id });

      const paymentId = await seedManualPayment(tx, fixture);
      await submitProofFor(tx, fixture, paymentId);

      const { cancelTeamRegistration } = await import("@/server/teams/team-registration-service");
      await expect(
        cancelTeamRegistration(
          fixture.userId,
          fixture.competitionId,
          team!.id,
          "berubah pikiran",
          tx as never,
        ),
      ).rejects.toMatchObject({
        code: "cancellation_not_supported_for_paid",
        message: "Pendaftaran tidak dapat dibatalkan setelah bukti transfer dikirim",
      });

      // Both rows, because the team write cancels the whole group in one statement — checking only
      // the captain's would miss a guard that ran after it.
      expect(await statusOf(tx, fixture.registrationId)).toBe("confirmed");
      expect(await statusOf(tx, mateRegistration!.id)).toBe("confirmed");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("what the deadline means to the payer (real database)", () => {
  // R5 AND R6, asked the way the CANDIDATE'S PAGE asks them.
  //
  // The sweep itself is covered elsewhere. What is covered here is that the surface telling a
  // candidate about the deadline reads the same rule the worker acts on — the suspension in
  // particular, because a countdown rendered next to evidence already submitted tells someone who
  // paid on time that they are late, and that is how a person transfers twice.

  const viewFor = async (tx: Tx, fixture: Fixture, registrationId?: string) => {
    const { loadCandidatePaymentView } = await import("@/server/finance/candidate-payment-view");
    return loadCandidatePaymentView(
      registrationId ?? fixture.registrationId,
      fixture.userId,
      tx as never,
    );
  };

  const submitProofFor = async (tx: Tx, fixture: Fixture, paymentId: string) => {
    const { submitManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return submitManualPaymentProof(
      {
        paymentId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      },
      tx as never,
    );
  };

  it("does NOT suspend the deadline while nothing has been submitted", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await seedManualPayment(tx, fixture);

      expect((await viewFor(tx, fixture))?.deadlineSuspended).toBe(false);
    });
  });

  it("SUSPENDS the deadline the moment a proof is awaiting review", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      await submitProofFor(tx, fixture, paymentId);

      expect((await viewFor(tx, fixture))?.deadlineSuspended).toBe(true);
    });
  });

  it("RESUMES the deadline once the proof is rejected", async () => {
    // A rejection puts the candidate back to owing money against a running clock. If this reported
    // suspended, the surface would tell someone with hours left that they had nothing to do.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProofFor(tx, fixture, paymentId);

      const { rejectManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      await rejectManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        "nominal tidak sesuai",
        true,
        tx as never,
        NOW,
      );

      expect((await viewFor(tx, fixture))?.deadlineSuspended).toBe(false);
    });
  });

  it("agrees with the worker: a suspended deadline does not expire the registration", async () => {
    // THE AGREEMENT ASSERTION. The page saying "you are safe" is only worth anything if the worker
    // then declines to cancel. Both are driven here, in one test, past an overdue deadline.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture, { dueAt: DUE });
      await submitProofFor(tx, fixture, paymentId);

      expect((await viewFor(tx, fixture))?.deadlineSuspended).toBe(true);

      const { sweepExpiredPayments } = await import("@/server/finance/payment-expiry-service");
      const result = await sweepExpiredPayments(
        new Date(DUE.getTime() + 30 * 86_400_000),
        tx as never,
      );

      expect(result.expired.some((entry) => entry.paymentId === paymentId)).toBe(false);
      expect(
        (
          await tx
            .select({ status: competitionRegistrations.status })
            .from(competitionRegistrations)
            .where(eq(competitionRegistrations.id, fixture.registrationId))
            .limit(1)
        )[0]!.status,
      ).toBe("confirmed");
    });
  });

  it("R6: expiry cancels with its OWN reason, separable from a withdrawal", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await seedManualPayment(tx, fixture, { dueAt: DUE });

      const { sweepExpiredPayments, PAYMENT_EXPIRY_CANCELLATION_REASON } = await import(
        "@/server/finance/payment-expiry-service"
      );
      await sweepExpiredPayments(new Date(DUE.getTime() + 86_400_000), tx as never);

      const [row] = await tx
        .select({
          status: competitionRegistrations.status,
          reason: competitionRegistrations.cancellationReason,
        })
        .from(competitionRegistrations)
        .where(eq(competitionRegistrations.id, fixture.registrationId))
        .limit(1);

      expect(row!.status).toBe("cancelled");
      // A sentinel, not prose. Every later report has to separate "the candidate withdrew" from
      // "nobody paid", and a human-written sentence cannot be filtered on.
      expect(row!.reason).toBe(PAYMENT_EXPIRY_CANCELLATION_REASON);
      expect(row!.reason).not.toBe("withdrew");

      // R6 has no capacity dimension: nothing is freed, and the copy must not suggest a seat was.
      // What actually holds is the opposite — the cancelled row still blocks re-registration.
      // Registration is opened first so the refusal below is the DUPLICATE guard rather than the
      // window guard, which fires earlier and would make this assertion pass for the wrong reason.
      await tx
        .update(competitions)
        .set({
          status: "published",
          mode: "individual",
          registrationStartAt: new Date(Date.now() - 86_400_000),
          registrationEndAt: new Date(Date.now() + 30 * 86_400_000),
        })
        .where(eq(competitions.id, fixture.competitionId));

      const { createIndividualRegistration } = await import(
        "@/server/registrations/registration-service"
      );
      await expect(
        createIndividualRegistration(fixture.userId, fixture.competitionId, tx as never),
      ).rejects.toMatchObject({ code: "registration_already_exists" });
    });
  });

  it("stays coherent with the cancel affordance: an expired registration offers neither control", async () => {
    // The surface 5 interaction. Expiry sets the row to `cancelled`, and the affordance resolver
    // asks its question only for a `confirmed` row — so an expired candidate sees no cancel button
    // AND no explanation of a withheld one, which would be a notice about a control that is gone.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture, { dueAt: DUE });
      await submitProofFor(tx, fixture, paymentId);

      const { rejectManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const [proofRow] = await tx
        .select({ id: financeManualPaymentProofs.id })
        .from(financeManualPaymentProofs)
        .where(eq(financeManualPaymentProofs.paymentId, paymentId))
        .limit(1);
      await rejectManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proofRow!.id,
        "nominal tidak sesuai",
        true,
        tx as never,
        NOW,
      );

      // Before expiry: a rejected proof still WITHHOLDS cancel — the one state where a candidate
      // cannot leave and can still be cancelled by the clock. That is what makes surfacing the
      // deadline on the rejection notice a fairness requirement rather than a nicety.
      const { resolveCancelAffordanceState } = await import("@/server/finance/cancel-affordance");
      expect(
        (
          await resolveCancelAffordanceState(
            { individualRegistration: { id: fixture.registrationId, status: "confirmed" }, team: null },
            tx as never,
          )
        ).individualCancellationClosed,
      ).toBe(true);

      const { sweepExpiredPayments } = await import("@/server/finance/payment-expiry-service");
      await sweepExpiredPayments(new Date(DUE.getTime() + 86_400_000), tx as never);

      // After expiry: the row is cancelled, so the resolver asks nothing and the page renders the
      // cancelled state rather than a withheld-control explanation.
      expect(
        await resolveCancelAffordanceState(
          { individualRegistration: { id: fixture.registrationId, status: "cancelled" }, team: null },
          tx as never,
        ),
      ).toEqual({ individualCancellationClosed: false, teamCancellationClosed: false });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("what an unverified institution is told (real database)", () => {
  // DEC-0170. A paid competition owned by an institution that cannot charge is a DEFINED RUNTIME
  // STATE — verification is revocable, and a competition priced while verified stays published
  // afterwards. The platform's answer is to stop NEW charging, never to take anything down.
  //
  // Both audiences are asserted here because they are owed different things: the organiser is owed
  // every blocker and what to do about each, the candidate is owed only that payment is
  // unavailable. A candidate is not owed the institution's verification status.

  const readiness = async (tx: Tx, institutionId: string) => {
    const { resolveChargingReadiness } = await import("@/server/finance/charging-readiness");
    return resolveChargingReadiness(institutionId, NOW, tx as never);
  };

  const publishInstructions = async (tx: Tx, institutionId: string) => {
    await tx.insert(institutionPaymentInstructions).values({
      institutionId,
      bankName: "Bank Mandiri",
      accountNumber: "1370012345678",
      accountHolderName: "Yayasan Uji",
    });
  };

  it("reports READY for a verified institution with instructions and a fee rule", async () => {
    await inRollback(async (tx) => {
      // The fixture's primary institution is verified and already publishes instructions.
      const fixture = await seedFixture(tx);

      expect(await readiness(tx, fixture.institutionId)).toEqual({ ready: true, blockers: [] });
    });
  });

  it("names EVERY blocker at once, not just the first", async () => {
    // The panel's whole job is to tell an organiser what to fix. Short-circuiting on the first
    // failure turns one task into three round trips through a verification queue.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await tx.delete(financeFeeRules).where(eq(financeFeeRules.id, fixture.feeRuleId));

      const result = await readiness(tx, fixture.unverifiedInstitutionId);

      expect(result.ready).toBe(false);
      expect([...result.blockers].sort()).toEqual([
        "fee_rule_not_in_force",
        "institution_unverified",
        "payment_instructions_missing",
      ]);
    });
  });

  it("reports the unverified institution as blocked even with instructions published", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await publishInstructions(tx, fixture.unverifiedInstitutionId);

      const result = await readiness(tx, fixture.unverifiedInstitutionId);

      expect(result.ready).toBe(false);
      expect(result.blockers).toEqual(["institution_unverified"]);
    });
  });

  it("agrees with the write path: not-ready means the registration is actually refused", async () => {
    // THE AGREEMENT ASSERTION, and the reason the resolver reuses the gates' own readers rather
    // than re-deriving them. A panel that says "you cannot charge" while the write path happily
    // creates a payment — or the reverse — is worse than no panel.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await tx
        .update(competitions)
        .set({
          feeAmount: 100_000,
          feeCurrency: "IDR",
          status: "published",
          mode: "individual",
          registrationStartAt: new Date(Date.now() - 86_400_000),
          registrationEndAt: new Date(Date.now() + 30 * 86_400_000),
        })
        .where(eq(competitions.id, fixture.competitionId));

      // Withdraw the published account, which is the revocable half an organiser controls.
      await tx
        .delete(institutionPaymentInstructions)
        .where(eq(institutionPaymentInstructions.institutionId, fixture.institutionId));

      expect((await readiness(tx, fixture.institutionId)).ready).toBe(false);

      const id = uniqueSuffix();
      const [newcomer] = await tx
        .insert(users)
        .values({
          email: `newcomer_${id}@example.test`,
          username: `newcomer_${id}`,
          candidateVerifiedAt: NOW,
        })
        .returning({ id: users.id });

      const { createIndividualRegistration } = await import(
        "@/server/registrations/registration-service"
      );
      await expect(
        createIndividualRegistration(newcomer!.id, fixture.competitionId, tx as never),
      ).rejects.toMatchObject({ code: "registration_payment_unavailable" });

      // And nothing was left behind: the registration rolls back with the payment it could not
      // create, so the candidate is not stranded holding a row they cannot pay for.
      const rows = await tx
        .select({ id: competitionRegistrations.id })
        .from(competitionRegistrations)
        .where(
          and(
            eq(competitionRegistrations.competitionId, fixture.competitionId),
            eq(competitionRegistrations.studentId, newcomer!.id),
          ),
        );
      expect(rows).toEqual([]);
    });
  });

  it("does NOT unpublish or hide the competition — charging is gated, publication is not", async () => {
    // DEC-0118's scope, preserved exactly. An organiser whose verification lapses keeps everything
    // already published; only new charging stops. `rejected` rather than "revoked": the enum has no
    // revoked value, and the readiness check keys off "not verified" so every non-verified status
    // behaves identically here.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await tx
        .update(competitions)
        .set({ feeAmount: 100_000, feeCurrency: "IDR", status: "published" })
        .where(eq(competitions.id, fixture.competitionId));
      await tx
        .update(institutions)
        .set({ verificationStatus: "rejected" })
        .where(eq(institutions.id, fixture.institutionId));

      expect((await readiness(tx, fixture.institutionId)).ready).toBe(false);

      const [row] = await tx
        .select({ status: competitions.status })
        .from(competitions)
        .where(eq(competitions.id, fixture.competitionId))
        .limit(1);
      expect(row!.status).toBe("published");
    });
  });

  it("reports an unknown slug as not-ready with NO blockers", async () => {
    await inRollback(async (tx) => {
      const { resolveChargingReadinessBySlug } = await import(
        "@/server/finance/charging-readiness"
      );
      expect(await resolveChargingReadinessBySlug("tidak-ada-institusi", NOW, tx as never)).toEqual({
        ready: false,
        blockers: [],
      });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("every A2 guard in the expiry worker (real database)", () => {
  // FIVE RETURNING GUARDS INSIDE ONE TRANSACTION, and a returning guard is not protected by the
  // rollback a throwing one gets: `return null` ends the callback normally, so the transaction
  // COMMITS whatever was written before it. Moved below the cancellation write, any of these
  // commits a wrong cancellation while reporting the payment as "skipped" — a silent wrong
  // cancellation on a lane where the platform cannot reverse the transfer, in a background worker
  // whose output nobody reads.
  //
  // Post-state is the detector for all of them, and correct position today is not the same as
  // covered. Two of the five are structurally unreachable and are shown to be, rather than asserted
  // to be; the other three carry tests.

  const submitProofFor = async (tx: Tx, fixture: Fixture, paymentId: string) => {
    const { submitManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return submitManualPaymentProof(
      {
        paymentId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      },
      tx as never,
    );
  };

  const sweepPast = async (tx: Tx) => {
    const { sweepExpiredPayments } = await import("@/server/finance/payment-expiry-service");
    return sweepExpiredPayments(new Date(DUE.getTime() + 30 * 86_400_000), tx as never);
  };

  const statusOf = async (tx: Tx, registrationId: string): Promise<string> => {
    const [row] = await tx
      .select({ status: competitionRegistrations.status })
      .from(competitionRegistrations)
      .where(eq(competitionRegistrations.id, registrationId))
      .limit(1);
    return row!.status;
  };

  it("GUARD 3 — a SUCCEEDED payment is not cancelled by a later sweep", async () => {
    // The worst of the five. This candidate transferred real money, the organiser verified it, and
    // a moved guard cancels their registration and reports the payment skipped.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture, { dueAt: DUE });
      const proof = await submitProofFor(tx, fixture, paymentId);

      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      await verifyManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        tx as never,
        NOW,
      );

      const result = await sweepPast(tx);

      expect(result.expired.some((e) => e.paymentId === paymentId)).toBe(false);
      expect(await statusOf(tx, fixture.registrationId)).toBe("confirmed");
    });
  });

  it("GUARD 4 — a second sweep does not re-cancel an already expired payment", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture, { dueAt: DUE });

      const first = await sweepPast(tx);
      expect(first.expired.some((e) => e.paymentId === paymentId)).toBe(true);
      expect(await statusOf(tx, fixture.registrationId)).toBe("cancelled");

      // The registration is put back by hand to a state the second sweep could damage. Without
      // this the CAS on `status = 'confirmed'` would mask a moved guard: the row is already
      // cancelled, so re-running the write changes nothing and post-state proves nothing.
      await tx
        .update(competitionRegistrations)
        .set({ status: "confirmed", cancelledAt: null, cancellationReason: null })
        .where(eq(competitionRegistrations.id, fixture.registrationId));

      const second = await sweepPast(tx);

      expect(second.expired.some((e) => e.paymentId === paymentId)).toBe(false);
      expect(await statusOf(tx, fixture.registrationId)).toBe("confirmed");
    });
  });

  // GUARD 2 — `if ([...locked].length === 0) return null;` — is likewise unreachable and gets no
  // fixture. The id being locked comes from `finance_payments.competition_registration_id`, which
  // carries a foreign key to `competition_registrations` with no ON DELETE action, and no code path
  // in this repository hard-deletes a registration row (cancellation is a status change; the row is
  // retained as a historical artefact). So `SELECT ... FOR UPDATE` on that id always finds a row.
  // Reaching it needs a referential-integrity violation, which the constraint prevents.

  it("GUARD 1 is UNREACHABLE — a payment cannot exist without a registration", async () => {
    // Shown, not asserted. `finance_payments_subject_xor_chk` requires the registration key to be
    // non-null for the only subject type that exists, so `!payment?.registrationId` is defensive
    // against a subject arm nobody has added yet. It gets no post-state detector because no fixture
    // can reach it without violating the constraint that makes it unreachable.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await expect(
        seedManualPayment(tx, fixture, { competitionRegistrationId: null }),
      ).rejects.toThrow();
    });
  });
});

describe.skipIf(skipWithoutDatabase)("what the manual lane announces (real database)", () => {
  // Rule 33: every assertion below reaches the queue through the real service — the real
  // transaction, the real `loadPaymentFacts` join, the real recipient resolvers. A hand-built
  // payload would prove the notification module and leave the four call sites unproven, which is
  // exactly the shape of this step's worst prior defect.
  const submitProof = async (tx: Tx, fixture: Fixture, paymentId: string) => {
    const { submitManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return submitManualPaymentProof(
      {
        paymentId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      },
      tx as never,
    );
  };

  const seedAdmin = async (
    tx: Tx,
    institutionId: string,
    label: string,
    membershipRole: "institution_owner" | "institution_staff" | "institution_member",
  ): Promise<string> => {
    const id = uniqueSuffix();
    const [user] = await tx
      .insert(users)
      .values({
        email: `${label}_${id}@example.test`,
        username: `${label}_${id}`,
        // Both columns together: `users_recruiter_tier_chk` refuses a verified recruiter still
        // sitting at the `unverified` tier.
        recruiterVerifiedAt: NOW,
        recruiterVerificationTier: "minimal",
      })
      .returning({ id: users.id });

    await tx
      .insert(institutionMemberships)
      .values({ institutionId, userId: user!.id, membershipRole });

    return user!.id;
  };

  it("tells the organiser a bukti transfer is waiting, and does not tell the payer they pressed a button", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      const proof = await submitProof(tx, fixture, paymentId);

      expect(mockEnqueuePaymentProofSubmitted).toHaveBeenCalledTimes(1);
      expect(mockEnqueuePaymentProofSubmitted).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId,
          proofId: proof.id,
          attempt: 0,
          institutionId: fixture.institutionId,
          grossAmount: 1_000_000,
          currency: "IDR",
        }),
      );

      // R13's first half. The payer already sees "Menunggu verifikasi" on the panel they just
      // submitted from; the people who need telling are the ones who can act.
      expect(mockEnqueuePaymentOutcome).not.toHaveBeenCalled();
    });
  });

  it("tells the organiser again when a rejected payer sends a replacement", async () => {
    // The proof row is REUSED on a resubmission, so the queue identity has to be the attempt and
    // not the proof. Without it the second bukti transfer is deduplicated away and the organiser
    // learns about it only if they happen to reopen the page.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);
      await rejectManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        "Foto tidak terbaca",
        true,
        tx as never,
        NOW,
      );
      mockEnqueuePaymentProofSubmitted.mockClear();

      await reopenManualPaymentProof(
        {
          proofId: proof.id,
          submittedByUserId: fixture.userId,
          r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti2.jpg`,
          originalFileName: "bukti2.jpg",
          fileSizeBytes: 4096,
          contentType: "image/jpeg",
        },
        tx as never,
        NOW,
      );

      expect(mockEnqueuePaymentProofSubmitted).toHaveBeenCalledTimes(1);
      expect(mockEnqueuePaymentProofSubmitted).toHaveBeenCalledWith(
        expect.objectContaining({ proofId: proof.id, attempt: 1 }),
      );
    });
  });

  it("announces a SECOND rejection of the same payment, not just the first", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      const reject = (reason: string) =>
        rejectManualPaymentProof(
          fixture.institutionId,
          fixture.userId,
          proof.id,
          reason,
          true,
          tx as never,
          NOW,
        );

      await reject("Foto tidak terbaca");
      await reopenManualPaymentProof(
        {
          proofId: proof.id,
          submittedByUserId: fixture.userId,
          r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti2.jpg`,
          originalFileName: "bukti2.jpg",
          fileSizeBytes: 4096,
          contentType: "image/jpeg",
        },
        tx as never,
        NOW,
      );
      await reject("Nominal masih kurang");

      const outcomes = mockEnqueuePaymentOutcome.mock.calls.map(
        (call) => call[0] as { outcome: string; attempt: number; rejectionReason: string | null },
      );

      // Two refusals, two announcements, distinguishable by attempt. The second is the one that
      // matters most — it lands with less of the deadline left than the first.
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]).toMatchObject({ outcome: "rejected", attempt: 0 });
      expect(outcomes[1]).toMatchObject({
        outcome: "rejected",
        attempt: 1,
        rejectionReason: "Nominal masih kurang",
      });
    });
  });

  it("carries both slugs, so the organiser's link opens the queue rather than a chooser", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await submitProof(tx, fixture, paymentId);

      const [institution] = await tx
        .select({ slug: institutions.slug })
        .from(institutions)
        .where(eq(institutions.id, fixture.institutionId));
      const [competition] = await tx
        .select({ slug: competitions.slug })
        .from(competitions)
        .where(eq(competitions.id, fixture.competitionId));

      expect(mockEnqueuePaymentProofSubmitted).toHaveBeenCalledWith(
        expect.objectContaining({
          institutionSlug: institution!.slug,
          competitionSlug: competition!.slug,
        }),
      );
    });
  });

  it("names the payer by their profile name, never by their email", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedManualPayment(tx, fixture);

      await tx.insert(candidateProfiles).values({
        userId: fixture.userId,
        fullName: "Sari Melati",
        phoneNumber: "081200000000",
        occupation: "college_student",
        dateOfBirth: "2004-01-01",
      });

      await submitProof(tx, fixture, paymentId);

      const payload = mockEnqueuePaymentProofSubmitted.mock.calls[0]![0] as {
        payerDisplayName: string;
      };
      expect(payload.payerDisplayName).toBe("Sari Melati");
      expect(payload.payerDisplayName).not.toContain("@");
    });
  });

  it("resolves the organiser set from THIS institution, never the rival's", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { listInstitutionAdminUserIds } = await import(
        "@/server/institution-members/member-service"
      );

      const owner = await seedAdmin(tx, fixture.institutionId, "owner", "institution_owner");
      const staff = await seedAdmin(tx, fixture.institutionId, "staff", "institution_staff");
      // Present in the same institution and deliberately excluded: `institution_member` has no
      // operational surface, so notifying them is telling someone about a decision they cannot make.
      const plain = await seedAdmin(tx, fixture.institutionId, "plain", "institution_member");
      // MANUAL-D6's second institution. A single-tenant fixture cannot fail this assertion.
      const rivalOwner = await seedAdmin(
        tx,
        fixture.other.institutionId,
        "rival",
        "institution_owner",
      );

      const recipients = await listInstitutionAdminUserIds(fixture.institutionId, tx as never);

      expect(recipients).toEqual(expect.arrayContaining([owner, staff]));
      expect(recipients).not.toContain(plain);
      expect(recipients).not.toContain(rivalOwner);
    });
  });

  it("drops a revoked membership from the organiser set", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { listInstitutionAdminUserIds } = await import(
        "@/server/institution-members/member-service"
      );

      const owner = await seedAdmin(tx, fixture.institutionId, "owner", "institution_owner");
      const departed = await seedAdmin(tx, fixture.institutionId, "gone", "institution_staff");
      await tx
        .update(institutionMemberships)
        .set({ status: "revoked" })
        .where(eq(institutionMemberships.userId, departed));

      const recipients = await listInstitutionAdminUserIds(fixture.institutionId, tx as never);

      expect(recipients).toEqual([owner]);
    });
  });

  it("announces a verification to the payer", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      await verifyManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        tx as never,
        NOW,
      );

      expect(mockEnqueuePaymentOutcome).toHaveBeenCalledTimes(1);
      expect(mockEnqueuePaymentOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId,
          registrationId: fixture.registrationId,
          outcome: "verified",
          // No reason, no bar. Neither exists for a verification, and carrying a stale one would
          // put a refusal sentence under a success notice.
          rejectionReason: null,
          resubmissionAllowed: null,
        }),
      );
    });
  });

  it("announces a rejection with the organiser's reason AND the bar they set", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      await rejectManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        "Nominal transfer tidak sesuai",
        false,
        tx as never,
        NOW,
      );

      expect(mockEnqueuePaymentOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId,
          outcome: "rejected",
          rejectionReason: "Nominal transfer tidak sesuai",
          // The bar travels with the notice. Without it the payer is told to try again on a path
          // the CAS will refuse.
          resubmissionAllowed: false,
        }),
      );
    });
  });

  it("announces an expiry with no organiser decision attached to it", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { sweepExpiredPayments } = await import("@/server/finance/payment-expiry-service");

      const paymentId = await seedManualPayment(tx, fixture, { dueAt: DUE });
      await tx
        .update(competitionRegistrations)
        .set({ status: "confirmed" })
        .where(eq(competitionRegistrations.id, fixture.registrationId));

      await sweepExpiredPayments(new Date(DUE.getTime() + 86_400_000), tx as never);

      expect(mockEnqueuePaymentOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId,
          outcome: "expired",
          // R6's copy rule at the payload layer: an expiry has no author, so there is no reason to
          // attribute and no resubmission the organiser allowed or refused.
          rejectionReason: null,
          resubmissionAllowed: null,
        }),
      );
    });
  });

  it("tells a payer nothing when the sweep declined to expire them", async () => {
    // A proof in `pending_review` SUSPENDS expiry indefinitely (R5). The sweep still examines the
    // payment and still declines it, so the dispatch has to sit inside the expired branch: moved
    // out of it, every skipped payment is told its registration was cancelled while the
    // registration is untouched — a false cancellation notice, which is worse than a missing one.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { sweepExpiredPayments } = await import("@/server/finance/payment-expiry-service");

      const paymentId = await seedManualPayment(tx, fixture, { dueAt: DUE });
      await tx
        .update(competitionRegistrations)
        .set({ status: "confirmed" })
        .where(eq(competitionRegistrations.id, fixture.registrationId));
      await submitProof(tx, fixture, paymentId);
      mockEnqueuePaymentOutcome.mockClear();

      const result = await sweepExpiredPayments(new Date(DUE.getTime() + 86_400_000), tx as never);

      expect(result.skipped).toBe(1);
      expect(result.expired).toHaveLength(0);
      expect(mockEnqueuePaymentOutcome).not.toHaveBeenCalled();

      const [row] = await tx
        .select({ status: competitionRegistrations.status })
        .from(competitionRegistrations)
        .where(eq(competitionRegistrations.id, fixture.registrationId));
      expect(row!.status).toBe("confirmed");
    });
  });

  it("announces a team's verdict against the anchor registration the whole group resolves from", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { resolvePaymentGroupMemberUserIds } = await import(
        "@/server/finance/paid-registration"
      );

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

      const memberUserIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const [member] = await tx
          .insert(users)
          .values({
            email: `teammate_${id}_${index}@example.test`,
            username: `teammate_${id}_${index}`,
            candidateVerifiedAt: NOW,
          })
          .returning({ id: users.id });

        await tx.insert(competitionRegistrations).values({
          competitionId: fixture.competitionId,
          studentId: member!.id,
          registrationType: "team",
          teamId: team!.id,
        });

        memberUserIds.push(member!.id);
      }

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      await verifyManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        tx as never,
        NOW,
      );

      const payload = mockEnqueuePaymentOutcome.mock.calls[0]![0] as { registrationId: string };
      // R13's second half, and the reason the payload carries a registration rather than a list:
      // the worker resolves recipients at delivery from this id, through the same helper the expiry
      // sweep cancels by. The set told and the set affected are one set by construction.
      const recipients = await resolvePaymentGroupMemberUserIds(payload.registrationId, tx as never);

      expect(recipients).toHaveLength(4);
      expect(recipients).toEqual(expect.arrayContaining([fixture.userId, ...memberUserIds]));
    });
  });

  it("keeps the verification when the queue is down", async () => {
    // CLASS B — the guard is the try/catch wrapping dispatch, it sits AFTER the write, and removing
    // it lets a queue outage propagate out of a service whose transaction has already committed.
    // The detector is post-state: the row is verified and the caller did not throw.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      mockEnqueuePaymentOutcome.mockRejectedValueOnce(new Error("redis unreachable"));

      await expect(
        verifyManualPaymentProof(fixture.institutionId, fixture.userId, proof.id, tx as never, NOW),
      ).resolves.toMatchObject({ status: "verified" });

      const [row] = await tx
        .select({ status: financeManualPaymentProofs.status })
        .from(financeManualPaymentProofs)
        .where(eq(financeManualPaymentProofs.id, proof.id));

      expect(row!.status).toBe("verified");
      expect(
        (
          await tx
            .select({ id: financeFeeAccruals.id })
            .from(financeFeeAccruals)
            .where(eq(financeFeeAccruals.paymentId, paymentId))
        ).length,
      ).toBe(1);
    });
  });

  it("announces nothing for a verification that rolled back", async () => {
    // THE MOVE DETECTOR for the dispatch position. Moving `notifyPaymentOutcome` inside the
    // transaction — anywhere above `recordFeeAccrual` — makes this test fail: the accrual throws,
    // the transaction unwinds, the proof is still pending_review, and the queue has been told the
    // payment succeeded. A refusal-identity detector cannot see that; only the pairing of the
    // surviving row with the absent enqueue can.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      // The lever: a payment that is no longer manual-lane. `recordFeeAccrual` refuses it —
      // a gateway payment's fee split at transaction time and accruing it again bills twice — and
      // that refusal is raised after the CAS has already written `verified`.
      await tx
        .update(financePayments)
        .set({ origin: "gateway" })
        .where(eq(financePayments.id, paymentId));

      await expect(
        verifyManualPaymentProof(fixture.institutionId, fixture.userId, proof.id, tx as never, NOW),
      ).rejects.toMatchObject({ code: "fee_accrual_not_manual_lane" });

      const [row] = await tx
        .select({ status: financeManualPaymentProofs.status })
        .from(financeManualPaymentProofs)
        .where(eq(financeManualPaymentProofs.id, proof.id));

      expect(row!.status).toBe("pending_review");
      expect(mockEnqueuePaymentOutcome).not.toHaveBeenCalled();
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the DEC-0132 escape hatch (real database)", () => {
  const submitProof = async (tx: Tx, fixture: Fixture, paymentId: string) => {
    const { submitManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return submitManualPaymentProof(
      {
        paymentId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      },
      tx as never,
    );
  };

  const publish = async (tx: Tx, competitionId: string) => {
    await tx
      .update(competitions)
      .set({ status: "published" })
      .where(eq(competitions.id, competitionId));
  };

  it("lists a competition held open by a bukti transfer awaiting review", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadOpsBlockedCompetitions } = await import("@/server/finance/ops-payment-review");

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);
      await publish(tx, fixture.competitionId);

      const blocked = await loadOpsBlockedCompetitions(tx as never);
      const entry = blocked.find((row) => row.competitionId === fixture.competitionId);

      // DEC-0132: this list IS the escape hatch. A competition missing from it is one nobody can
      // rescue, so the assertion is presence, not shape.
      expect(entry).toBeDefined();
      expect(entry!.proofs.map((p) => p.proofId)).toContain(proof.id);
      expect(entry!.status).toBe("published");
    });
  });

  it("shows the same set the unpublish block raises, on both in-flight statuses", async () => {
    // The two lists are one list or the hatch is narrower than the block. `verified` is the arm
    // that would be missed by an intuitive "awaiting review" reading, and a competition blocked by
    // a verified proof is exactly the one an organiser cannot escape on their own.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadOpsBlockedCompetitions } = await import("@/server/finance/ops-payment-review");
      const { hasCompetitionPaymentInFlight } = await import("@/server/finance/paid-registration");
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);
      await verifyManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        tx as never,
        NOW,
      );

      expect(await hasCompetitionPaymentInFlight(fixture.competitionId, tx as never)).toBe(true);

      const blocked = await loadOpsBlockedCompetitions(tx as never);
      const entry = blocked.find((row) => row.competitionId === fixture.competitionId);

      expect(entry).toBeDefined();
      // Listed, but the void is WITHHELD: the CAS accepts only `pending_review`.
      expect(entry!.proofs[0]!.status).toBe("verified");
      expect(entry!.proofs[0]!.voidable).toBe(false);
    });
  });

  it("drops a competition from the hatch once its last proof is voided", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadOpsBlockedCompetitions } = await import("@/server/finance/ops-payment-review");
      const { hasCompetitionPaymentInFlight } = await import("@/server/finance/paid-registration");
      const { voidPaymentProofAsOps } = await import("@/server/finance/ops-payment-service");

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);
      await publish(tx, fixture.competitionId);

      await voidPaymentProofAsOps(
        fixture.other.userId,
        proof.id,
        "Bukti milik peserta lain",
        tx as never,
        NOW,
      );

      // The block is released, so the organiser can withdraw the competition themselves and the
      // hatch correctly has nothing left to offer.
      expect(await hasCompetitionPaymentInFlight(fixture.competitionId, tx as never)).toBe(false);
      const blocked = await loadOpsBlockedCompetitions(tx as never);
      expect(blocked.find((row) => row.competitionId === fixture.competitionId)).toBeUndefined();
    });
  });

  it("tells the payer a void happened, naming Lombakita and not the organiser", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { voidPaymentProofAsOps } = await import("@/server/finance/ops-payment-service");

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);
      mockEnqueuePaymentOutcome.mockClear();

      await voidPaymentProofAsOps(
        fixture.other.userId,
        proof.id,
        "Bukti milik peserta lain",
        tx as never,
        NOW,
      );

      expect(mockEnqueuePaymentOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId,
          outcome: "voided",
          rejectionReason: "Bukti milik peserta lain",
          // NEVER a bar. The voided arm of the reopen CAS bypasses the organiser's setting, so
          // sending one here would print a restriction the write path does not apply.
          resubmissionAllowed: null,
          attempt: 0,
        }),
      );
    });
  });

  it("gives a void and the resubmission that follows it separate identities", async () => {
    // Finding 26's shape on the arm that had never been exercised end to end. The proof row is
    // reused by the reopen, so without the attempt the second void collides with the first and the
    // payer is told once about two different decisions.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { voidPaymentProofAsOps } = await import("@/server/finance/ops-payment-service");
      const { reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      await voidPaymentProofAsOps(fixture.other.userId, proof.id, "Salah unggah", tx as never, NOW);
      mockEnqueuePaymentProofSubmitted.mockClear();

      await reopenManualPaymentProof(
        {
          proofId: proof.id,
          submittedByUserId: fixture.userId,
          r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti2.jpg`,
          originalFileName: "bukti2.jpg",
          fileSizeBytes: 4096,
          contentType: "image/jpeg",
        },
        tx as never,
        NOW,
      );

      await voidPaymentProofAsOps(fixture.other.userId, proof.id, "Salah lagi", tx as never, NOW);

      // The organiser hears about the replacement, at attempt 1.
      expect(mockEnqueuePaymentProofSubmitted).toHaveBeenCalledWith(
        expect.objectContaining({ proofId: proof.id, attempt: 1 }),
      );

      const voids = mockEnqueuePaymentOutcome.mock.calls
        .map((call) => call[0] as { outcome: string; attempt: number })
        .filter((payload) => payload.outcome === "voided");

      expect(voids).toHaveLength(2);
      expect(voids[0]!.attempt).toBe(0);
      expect(voids[1]!.attempt).toBe(1);
    });
  });

  it("reopens a voided proof, bumping the attempt", async () => {
    // R9/R20's reachable half. A void removes the payer's evidence without ruling on their money,
    // so leaving them unable to resend it would strand someone platform_ops itself acted on.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { voidPaymentProofAsOps } = await import("@/server/finance/ops-payment-service");

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);
      await voidPaymentProofAsOps(fixture.other.userId, proof.id, "Salah unggah", tx as never, NOW);

      const reopened = await reopenManualPaymentProof(
        {
          proofId: proof.id,
          submittedByUserId: fixture.userId,
          r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti2.jpg`,
          originalFileName: "bukti2.jpg",
          fileSizeBytes: 4096,
          contentType: "image/jpeg",
        },
        tx as never,
        NOW,
      );

      expect(reopened).toMatchObject({ status: "pending_review", resubmissionCount: 1 });
    });
  });

  it("holds the organiser's bar against a REJECTED proof, which is the only row that can carry one", async () => {
    // THE VOIDED ARM'S BAR-BYPASS IS UNREACHABLE, and this test is where that is shown rather than
    // asserted. `resubmission_allowed = false` is written by exactly one function — the organiser's
    // rejection — which leaves the row `rejected`. Void CASes on `pending_review`. The only path
    // from `rejected` back to `pending_review` is the reopen, whose rejected arm REQUIRES the bar
    // to be true. So a barred row can never become a voided row, and `status = 'voided'` ignoring
    // the bar is defensive rather than load-bearing today.
    //
    // It is kept, not deleted: the arm costs nothing and the day a second writer of the bar appears
    // — a platform_ops bar, an automated one — the state becomes reachable and the bypass is
    // already correct. What must not happen is a UI reintroducing the bar on the voided path.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      await rejectManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        "Bukan transfer ke rekening kami",
        false,
        tx as never,
        NOW,
      );

      await expect(
        reopenManualPaymentProof(
          {
            proofId: proof.id,
            submittedByUserId: fixture.userId,
            r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti2.jpg`,
            originalFileName: "bukti2.jpg",
            fileSizeBytes: 4096,
            contentType: "image/jpeg",
          },
          tx as never,
          NOW,
        ),
      ).rejects.toMatchObject({ code: "manual_proof_resubmission_barred" });

      // And the row is still barred and still rejected — so there is no state from here that a
      // void could act on.
      const [row] = await tx
        .select({
          status: financeManualPaymentProofs.status,
          resubmissionAllowed: financeManualPaymentProofs.resubmissionAllowed,
        })
        .from(financeManualPaymentProofs)
        .where(eq(financeManualPaymentProofs.id, proof.id));
      expect(row).toMatchObject({ status: "rejected", resubmissionAllowed: false });
    });
  });

  it("refuses both operator actions without a reason, and writes nothing", async () => {
    // WHICH MOVE WAS MEASURED, because for this guard the obvious one proves nothing. Relocating
    // `requireReason` INSIDE the transaction leaves this test green — the throw rolls the callback
    // back, so post-state is restored either way and the two positions are equivalent. The move
    // that is harmful is across the COMMIT boundary: below `db.transaction`, the cancellation lands
    // with an empty audit reason and only then refuses the caller, which the status assertion below
    // does catch. A guard sitting before a transaction is paired on the commit boundary, not on
    // statement order within the callback.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { voidPaymentProofAsOps, cancelCompetitionAsOps } = await import(
        "@/server/finance/ops-payment-service"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);
      await publish(tx, fixture.competitionId);

      await expect(
        voidPaymentProofAsOps(fixture.other.userId, proof.id, "   ", tx as never, NOW),
      ).rejects.toMatchObject({ code: "ops_reason_required" });
      await expect(
        cancelCompetitionAsOps(fixture.other.userId, fixture.competitionId, "", tx as never, NOW),
      ).rejects.toMatchObject({ code: "ops_reason_required" });

      // Post-state, because the reason check sits before any write: an override with no recorded
      // justification must leave the proof in flight and the competition published.
      const [row] = await tx
        .select({ status: financeManualPaymentProofs.status })
        .from(financeManualPaymentProofs)
        .where(eq(financeManualPaymentProofs.id, proof.id));
      expect(row!.status).toBe("pending_review");

      const [competition] = await tx
        .select({ status: competitions.status })
        .from(competitions)
        .where(eq(competitions.id, fixture.competitionId));
      expect(competition!.status).toBe("published");
    });
  });

  it("cancels the competition and every registration on it, writing no finance event", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { cancelCompetitionAsOps } = await import("@/server/finance/ops-payment-service");

      const paymentId = await seedManualPayment(tx, fixture);
      await submitProof(tx, fixture, paymentId);
      await publish(tx, fixture.competitionId);
      await tx
        .update(competitionRegistrations)
        .set({ status: "confirmed" })
        .where(eq(competitionRegistrations.id, fixture.registrationId));

      const eventsBefore = await tx
        .select({ id: financePaymentEvents.id })
        .from(financePaymentEvents)
        .where(eq(financePaymentEvents.paymentId, paymentId));

      const result = await cancelCompetitionAsOps(
        fixture.other.userId,
        fixture.competitionId,
        "Penyelenggara meminta penarikan lewat dukungan",
        tx as never,
        NOW,
      );

      expect(result.cancelledRegistrationCount).toBe(1);

      const [competition] = await tx
        .select({ status: competitions.status })
        .from(competitions)
        .where(eq(competitions.id, fixture.competitionId));
      expect(competition!.status).toBe("draft");

      // R7: cancelling says nothing about whether any transfer arrived, so the append-only ledger
      // gains nothing. A `failed` event here would assert the payment did not happen, which nobody
      // has established.
      const eventsAfter = await tx
        .select({ id: financePaymentEvents.id })
        .from(financePaymentEvents)
        .where(eq(financePaymentEvents.paymentId, paymentId));
      expect(eventsAfter).toHaveLength(eventsBefore.length);
    });
  });

  it("leaves the accrued platform fee standing when the competition is cancelled", async () => {
    // R8. The fee accrued when the organiser verified a real transfer; cancelling the competition
    // afterwards does not un-happen that, and this step writes no reversal. The operator copy says
    // so outright because nothing in the product will undo it for them.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { cancelCompetitionAsOps } = await import("@/server/finance/ops-payment-service");

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);
      await verifyManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        tx as never,
        NOW,
      );
      await publish(tx, fixture.competitionId);

      await cancelCompetitionAsOps(
        fixture.other.userId,
        fixture.competitionId,
        "Acara dibatalkan",
        tx as never,
        NOW,
      );

      const accruals = await tx
        .select({ entryType: financeFeeAccruals.entryType })
        .from(financeFeeAccruals)
        .where(eq(financeFeeAccruals.paymentId, paymentId));

      expect(accruals).toHaveLength(1);
      expect(accruals[0]!.entryType).toBe("accrued");
    });
  });

  it("records the operator, the reason and the subject on every override", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { voidPaymentProofAsOps } = await import("@/server/finance/ops-payment-service");

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      await voidPaymentProofAsOps(
        fixture.other.userId,
        proof.id,
        "Bukti milik peserta lain",
        tx as never,
        NOW,
      );

      const [audit] = await tx
        .select({
          actorUserId: platformOpsAuditLogs.actorUserId,
          eventType: platformOpsAuditLogs.eventType,
          reason: platformOpsAuditLogs.reason,
          metadata: platformOpsAuditLogs.metadata,
        })
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.actorUserId, fixture.other.userId));

      expect(audit).toMatchObject({
        eventType: "platform_ops_payment_proof_voided",
        reason: "Bukti milik peserta lain",
      });
      // The attempt is on the audit row too: two voids on one proof are two decisions, and an audit
      // trail that cannot tell them apart cannot answer which one is being asked about.
      expect(audit!.metadata).toMatchObject({ proofId: proof.id, paymentId, attempt: 0 });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("who is told where the money went (real database)", () => {
  it("counts the payer, and not the teammates who never transferred", async () => {
    // The cancellation notice's refund sentence rides on this set. A team pays once through its
    // captain, so a per-registrant reading would send three people to chase a refund for a transfer
    // they never made.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadCompetitionPayerUserIds } = await import("@/server/finance/paid-registration");

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

      const teammateIds: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const [member] = await tx
          .insert(users)
          .values({
            email: `mate_${id}_${index}@example.test`,
            username: `mate_${id}_${index}`,
            candidateVerifiedAt: NOW,
          })
          .returning({ id: users.id });
        await tx.insert(competitionRegistrations).values({
          competitionId: fixture.competitionId,
          studentId: member!.id,
          registrationType: "team",
          teamId: team!.id,
        });
        teammateIds.push(member!.id);
      }

      await seedManualPayment(tx, fixture);

      const payers = await loadCompetitionPayerUserIds(fixture.competitionId, tx as never);

      expect([...payers]).toEqual([fixture.userId]);
      for (const teammate of teammateIds) {
        expect(payers.has(teammate)).toBe(false);
      }
    });
  });

  it("counts nobody on a competition that charged nothing", async () => {
    // Paired with the case above. A zero-priced payment moved no money, so its holder must not be
    // told to ask for any back.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadCompetitionPayerUserIds } = await import("@/server/finance/paid-registration");

      await seedManualPayment(tx, fixture, {
        grossAmount: 0,
        institutionNetAmount: 0,
        platformFeeAmount: 0,
      });

      expect([...(await loadCompetitionPayerUserIds(fixture.competitionId, tx as never))]).toEqual(
        [],
      );
    });
  });

  it("does not count a payer on another institution's competition", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadCompetitionPayerUserIds } = await import("@/server/finance/paid-registration");

      await seedManualPayment(tx, fixture);

      // MANUAL-D6's second tenant: its competition took no payment, so it must resolve to nobody
      // even though a payer exists one row away.
      expect([
        ...(await loadCompetitionPayerUserIds(fixture.other.competitionId, tx as never)),
      ]).toEqual([]);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the finance_ops dispute view (real database)", () => {
  const submitProof = async (tx: Tx, fixture: Fixture, paymentId: string) => {
    const { submitManualPaymentProof } = await import(
      "@/server/finance/manual-payment-proof-service"
    );
    return submitManualPaymentProof(
      {
        paymentId,
        submittedByUserId: fixture.userId,
        r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti.jpg`,
        originalFileName: "bukti.jpg",
        fileSizeBytes: 2048,
        contentType: "image/jpeg",
      },
      tx as never,
    );
  };

  it("shows the attempt a resubmission overwrote — the whole reason the history table exists", async () => {
    // The live row carries attempt two's file, reason and verdict. Attempt one survives ONLY in
    // finance_manual_payment_proof_attempts, and attempt one is what the dispute is about.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { loadDisputePaymentDetail } = await import("@/server/finance/dispute-view");

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);
      await rejectManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        "Tanggal transfer tidak terbaca",
        true,
        tx as never,
        NOW,
      );
      await reopenManualPaymentProof(
        {
          proofId: proof.id,
          submittedByUserId: fixture.userId,
          r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti2.jpg`,
          originalFileName: "bukti2.jpg",
          fileSizeBytes: 4096,
          contentType: "image/jpeg",
        },
        tx as never,
        NOW,
      );

      const detail = await loadDisputePaymentDetail(paymentId, tx as never);

      // The live row is attempt two, with the earlier reason cleared.
      expect(detail!.originalFileName).toBe("bukti2.jpg");
      expect(detail!.rejectionReason).toBeNull();

      // And attempt one is still readable, with the reason the candidate is disputing.
      expect(detail!.history).toHaveLength(1);
      expect(detail!.history[0]).toMatchObject({
        attemptNumber: 0,
        originalFileName: "bukti.jpg",
        verdict: "rejected",
        verdictReason: "Tanggal transfer tidak terbaca",
      });
    });
  });

  it("reads the history forwards, oldest attempt first", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { rejectManualPaymentProof, reopenManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { loadDisputePaymentDetail } = await import("@/server/finance/dispute-view");

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      for (const [index, reason] of ["Alasan pertama", "Alasan kedua"].entries()) {
        await rejectManualPaymentProof(
          fixture.institutionId,
          fixture.userId,
          proof.id,
          reason,
          true,
          tx as never,
          NOW,
        );
        await reopenManualPaymentProof(
          {
            proofId: proof.id,
            submittedByUserId: fixture.userId,
            r2Key: `payment-proofs/${fixture.competitionId}/${paymentId}/bukti${index + 2}.jpg`,
            originalFileName: `bukti${index + 2}.jpg`,
            fileSizeBytes: 4096,
            contentType: "image/jpeg",
          },
          tx as never,
          NOW,
        );
      }

      const detail = await loadDisputePaymentDetail(paymentId, tx as never);

      // A dispute is read in the order it happened. Newest-first would put the operator at the end
      // of the argument and make them work backwards to its start.
      expect(detail!.history.map((attempt) => attempt.verdictReason)).toEqual([
        "Alasan pertama",
        "Alasan kedua",
      ]);
    });
  });

  it("sees both institutions at once, because a dispute does not arrive naming a tenant", async () => {
    // THE INVERTED NEGATIVE. Everywhere else in this lane the second fixture institution proves a
    // reader CANNOT cross tenants. finance_ops is platform-scoped, so here it proves the opposite,
    // and a tenant-scoped list would make the operator guess the answer before asking the question.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadDisputePayments } = await import("@/server/finance/dispute-view");

      const ownPaymentId = await seedManualPayment(tx, fixture);
      await submitProof(tx, fixture, ownPaymentId);

      await tx.insert(institutionPaymentInstructions).values({
        institutionId: fixture.other.institutionId,
        bankName: "Bank Saingan",
        accountNumber: "9999999999",
        accountHolderName: "Panitia Saingan",
      });
      const [rivalPayment] = await tx
        .insert(financePayments)
        .values(
          manualPaymentValues(fixture, {
            payerUserId: fixture.other.userId,
            receivingInstitutionId: fixture.other.institutionId,
            competitionRegistrationId: fixture.other.registrationId,
          }),
        )
        .returning({ id: financePayments.id });
      const { submitManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      await submitManualPaymentProof(
        {
          paymentId: rivalPayment!.id,
          submittedByUserId: fixture.other.userId,
          r2Key: `payment-proofs/${fixture.other.competitionId}/${rivalPayment!.id}/bukti.jpg`,
          originalFileName: "bukti.jpg",
          fileSizeBytes: 2048,
          contentType: "image/jpeg",
        },
        tx as never,
      );

      const payments = await loadDisputePayments(tx as never);
      const ids = payments.map((row) => row.paymentId);

      expect(ids).toContain(ownPaymentId);
      expect(ids).toContain(rivalPayment!.id);
    });
  });

  it("folds the ledger rather than trusting a status column, because there is none", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { loadDisputeLedgerState } = await import("@/server/finance/dispute-view");

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      expect((await loadDisputeLedgerState(paymentId, tx as never)).status).toBe("pending");

      await verifyManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        proof.id,
        tx as never,
        NOW,
      );

      const state = await loadDisputeLedgerState(paymentId, tx as never);
      // What the append-only stream SAYS moved — the figure a billing dispute actually turns on.
      expect(state.status).toBe("succeeded");
      expect(state.netRecordedAmount).toBe(1_000_000);
    });
  });

  it("records a dispute read against the PAYER, under its own event type", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { recordDisputeProofAccess, FILE_ACCESSED_EVENT } = await import(
        "@/server/finance/dispute-view"
      );

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      // The audit writer directly, NOT through the presigning path. Object storage is unconfigured
      // in this environment, so routing this assertion through `generateDisputeProofViewUrl` would
      // take the storage-unavailable branch every time and leave every expectation below
      // unexecuted — a green reporting an audit trail nobody measured.
      await recordDisputeProofAccess(
        fixture.other.userId,
        {
          id: proof.id,
          paymentId,
          competitionId: fixture.competitionId,
          attempt: proof.resubmissionCount,
          payerUserId: fixture.userId,
        },
        tx as never,
      );

      const [audit] = await tx
        .select({
          eventType: platformOpsAuditLogs.eventType,
          targetUserId: platformOpsAuditLogs.targetUserId,
          targetInstitutionId: platformOpsAuditLogs.targetInstitutionId,
          reason: platformOpsAuditLogs.reason,
          metadata: platformOpsAuditLogs.metadata,
        })
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.actorUserId, fixture.other.userId));

      // A DISTINCT event type from the organiser's `payment_proof.file_accessed`, and targeted at
      // the payer rather than an institution. Reusing the organiser's path would file a
      // platform-wide read under one tenant's own trail and make the two indistinguishable — which
      // is exactly the question an access dispute has to answer.
      expect(audit!.eventType).toBe(FILE_ACCESSED_EVENT);
      expect(audit!.eventType).not.toBe("payment_proof.file_accessed");
      expect(audit!.targetUserId).toBe(fixture.userId);
      expect(audit!.targetInstitutionId).toBeNull();
      expect(audit!.reason).toBe("Penanganan sengketa pembayaran");
      expect(audit!.metadata).toMatchObject({ proofId: proof.id, paymentId, attempt: 0 });
    });
  });

  it("writes no audit row when storage is down, because no file was read", async () => {
    // The ordering property, and the branch this environment actually runs. With object storage
    // unconfigured the presigner is never reached, so an audit row here would put an operator at a
    // receipt they could not have opened.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { isR2Available } = await import("@/server/storage/r2.client");
      const { generateDisputeProofViewUrl } = await import("@/server/finance/dispute-view");

      // Stated rather than assumed: if this environment ever gains storage credentials, the
      // assertion below stops describing it and the test says so instead of quietly inverting.
      expect(isR2Available()).toBe(false);

      const paymentId = await seedManualPayment(tx, fixture);
      const proof = await submitProof(tx, fixture, paymentId);

      await expect(
        generateDisputeProofViewUrl(fixture.other.userId, proof.id, tx as never),
      ).rejects.toMatchObject({ code: "manual_proof_upload_unavailable" });

      const rows = await tx
        .select({ id: platformOpsAuditLogs.id })
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.actorUserId, fixture.other.userId));

      expect(rows).toHaveLength(0);
    });
  });

  it("writes no audit row for a proof that does not exist", async () => {
    // An audit entry for a read that was refused records an access that never happened, which is
    // worse than no entry: it puts an operator at a receipt they never saw.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { generateDisputeProofViewUrl } = await import("@/server/finance/dispute-view");

      await expect(
        generateDisputeProofViewUrl(fixture.other.userId, "no-such-proof", tx as never),
      ).rejects.toMatchObject({ code: "manual_proof_not_found" });

      const rows = await tx
        .select({ id: platformOpsAuditLogs.id })
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.actorUserId, fixture.other.userId));

      expect(rows).toHaveLength(0);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the institution fee statement (real database)", () => {
  // A READ-ONLY surface, so the detector is the CONTENT OF THE RESULT rather than a post-state:
  // there is nothing this function writes whose absence could stand in for a refusal.
  //
  // Every accrual under test is written by `verifyManualPaymentProof` — the production verdict path
  // — not by an insert built here. A hand-constructed accrual row would prove the query and nothing
  // about whether the figures the organiser is billed on ever reach this page.

  it("renders the rate the line was PRICED under after the platform rate moves", async () => {
    // DEC-0171. The rule is versioned and a later one supersedes it, so a statement that joined
    // `finance_fee_rules` would show a rate this institution was never charged — wrong in exactly
    // the direction that starts a billing dispute.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { loadInstitutionFeeStatement } = await import("@/server/finance/fee-statement");

      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId);
      await verifyManualPaymentProof(fixture.institutionId, fixture.userId, proofId, tx as never, NOW);

      // The rate moves UNDERNEATH the accrual, which is the whole point: the snapshot has to
      // survive the rule changing, and only a real rule row can change.
      await tx
        .update(financeFeeRules)
        .set({ basisPoints: 1_000, flatAmount: 50_000 })
        .where(eq(financeFeeRules.id, fixture.feeRuleId));

      const statement = await loadInstitutionFeeStatement(fixture.institutionId, tx as never);

      expect(statement.lines).toHaveLength(1);
      expect(statement.lines[0]!.feeBasisPoints).toBe(250);
      expect(statement.lines[0]!.feeFlatAmount).toBe(0);
      // 250bp of 1_000_000, priced when the payment was verified.
      expect(statement.lines[0]!.amount).toBe(25_000);
      expect(statement.lines[0]!.grossAmount).toBe(1_000_000);
      expect(statement.outstandingAmount).toBe(25_000);
    });
  });

  it("nets a reversal to zero rather than doubling it", async () => {
    // The accrual row stores the reversal ALREADY NEGATED, so a statement that negates a `reversed`
    // row a second time reports 2x the fee on the line labelled "not yet billed". Overstating a
    // receivable is the failure direction that costs an institution money, and no fixture in the
    // seed set contains a reversal, so nothing else in the suite would show it.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { recordFeeAccrualReversal, sumOutstandingFeeAccruals } = await import(
        "@/server/finance/fee-accrual-service"
      );
      const { loadInstitutionFeeStatement } = await import("@/server/finance/fee-statement");

      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId);
      await verifyManualPaymentProof(fixture.institutionId, fixture.userId, proofId, tx as never, NOW);
      await recordFeeAccrualReversal(paymentId, "transfer tidak pernah masuk", tx as never);

      const statement = await loadInstitutionFeeStatement(fixture.institutionId, tx as never);

      expect(statement.lines).toHaveLength(2);
      expect(statement.accruedAmount).toBe(25_000);
      // Positive, because it renders under an explicit "−" prefix. Negative here would also make
      // the page's `reversedAmount > 0` test false and hide the correction entirely.
      expect(statement.reversedAmount).toBe(25_000);
      expect(statement.outstandingAmount).toBe(0);

      // Pinned to the figure every other caller reads, so the page and the service cannot drift.
      expect(statement.outstandingAmount).toBe(
        await sumOutstandingFeeAccruals(fixture.institutionId, tx as never),
      );
    });
  });

  it("signs each line as stored, so summing the column IS the receivable", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { recordFeeAccrualReversal } = await import("@/server/finance/fee-accrual-service");
      const { loadInstitutionFeeStatement } = await import("@/server/finance/fee-statement");

      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId);
      await verifyManualPaymentProof(fixture.institutionId, fixture.userId, proofId, tx as never, NOW);
      await recordFeeAccrualReversal(paymentId, "koreksi", tx as never);

      const statement = await loadInstitutionFeeStatement(fixture.institutionId, tx as never);
      const reversal = statement.lines.find((line) => line.entryType === "reversed");

      expect(reversal!.amount).toBe(-25_000);
      expect(reversal!.reason).toBe("koreksi");
      expect(statement.lines.reduce((total, line) => total + line.amount, 0)).toBe(0);
    });
  });

  it("shows one institution NOTHING of what a second institution owes", async () => {
    // The scope is in the WHERE on `owing_institution_id`, not a filter applied afterwards. Both
    // tenants accrue through the same production path, so a missing scope surfaces as the rival's
    // money appearing on this institution's bill rather than as an empty result either way.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { loadInstitutionFeeStatement } = await import("@/server/finance/fee-statement");

      const minePaymentId = await seedManualPayment(tx, fixture);
      const mineProofId = await seedProof(tx, fixture, minePaymentId);
      await verifyManualPaymentProof(
        fixture.institutionId,
        fixture.userId,
        mineProofId,
        tx as never,
        NOW,
      );

      // The rival needs its own published account before it may charge anyone, exactly as the
      // primary does — `seedFixture` deliberately leaves it without one.
      await tx.insert(institutionPaymentInstructions).values({
        institutionId: fixture.other.institutionId,
        bankName: "Bank Saingan",
        accountNumber: "9876543210",
        accountHolderName: "Panitia Saingan",
      });

      const [rivalPayment] = await tx
        .insert(financePayments)
        .values({
          ...manualPaymentValues(fixture),
          payerUserId: fixture.other.userId,
          receivingInstitutionId: fixture.other.institutionId,
          competitionRegistrationId: fixture.other.registrationId,
          grossAmount: 4_000_000,
          institutionNetAmount: 4_000_000,
        })
        .returning({ id: financePayments.id });

      const rivalProofId = await seedProof(tx, fixture.other, rivalPayment!.id);
      await verifyManualPaymentProof(
        fixture.other.institutionId,
        fixture.other.userId,
        rivalProofId,
        tx as never,
        NOW,
      );

      const accrualIdFor = async (forPaymentId: string): Promise<string> => {
        const [row] = await tx
          .select({ id: financeFeeAccruals.id })
          .from(financeFeeAccruals)
          .where(eq(financeFeeAccruals.paymentId, forPaymentId));
        return row!.id;
      };
      const mineAccrualId = await accrualIdFor(minePaymentId);
      const rivalAccrualId = await accrualIdFor(rivalPayment!.id);

      const mine = await loadInstitutionFeeStatement(fixture.institutionId, tx as never);
      const theirs = await loadInstitutionFeeStatement(fixture.other.institutionId, tx as never);

      // ASKED-FOR SETS on both sides. A length check alone passes if each statement returned the
      // OTHER tenant's single row, which is precisely the failure a missing scope produces.
      expect(mine.lines.map((line) => line.accrualId)).toEqual([mineAccrualId]);
      expect(theirs.lines.map((line) => line.accrualId)).toEqual([rivalAccrualId]);
      expect(mine.lines[0]!.amount).toBe(25_000);
      expect(theirs.lines[0]!.amount).toBe(100_000);
      expect(mine.outstandingAmount).toBe(25_000);
      expect(theirs.outstandingAmount).toBe(100_000);
    });
  });

  it("scopes the rate acknowledgements to this institution's own competitions", async () => {
    // Two conditions, and the test needs both to be load-bearing: the acknowledgement's own
    // `institution_id`, and the competition still belonging to that institution. A row whose
    // competition has moved tenants would otherwise render a rival's competition title against
    // this institution's agreement.
    await inRollback(async (tx) => {
      const { loadInstitutionFeeStatement } = await import("@/server/finance/fee-statement");
      const fixture = await seedFixture(tx);

      await tx.insert(financeFeeDisclosureAcknowledgements).values([
        {
          competitionId: fixture.competitionId,
          institutionId: fixture.institutionId,
          acknowledgedByUserId: fixture.userId,
          feeRuleId: fixture.feeRuleId,
          feeBasisPoints: 250,
          feeFlatAmount: 0,
          feeAmount: 25_000,
          feeCurrency: "IDR",
        },
        {
          competitionId: fixture.other.competitionId,
          institutionId: fixture.other.institutionId,
          acknowledgedByUserId: fixture.other.userId,
          feeRuleId: fixture.feeRuleId,
          feeBasisPoints: 250,
          feeFlatAmount: 0,
          feeAmount: 99_000,
          feeCurrency: "IDR",
        },
        // THE ROW THAT MAKES THE SECOND CONDITION LOAD-BEARING. Its `institution_id` is mine, so
        // the first condition admits it; only the competition-ownership check excludes it. Without
        // this row the join condition could be deleted outright and this test would stay green,
        // which is presence rather than enforcement. The shape is insertable — the two foreign keys
        // are independent and nothing pairs them — so it is drift the query has to survive.
        {
          competitionId: fixture.other.competitionId,
          institutionId: fixture.institutionId,
          acknowledgedByUserId: fixture.userId,
          feeRuleId: fixture.feeRuleId,
          feeBasisPoints: 250,
          feeFlatAmount: 0,
          feeAmount: 77_000,
          feeCurrency: "IDR",
        },
      ]);

      const mine = await loadInstitutionFeeStatement(fixture.institutionId, tx as never);

      expect(mine.acknowledgements.map((ack) => ack.competitionId)).toEqual([
        fixture.competitionId,
      ]);
      expect(mine.acknowledgements.map((ack) => ack.feeAmount)).toEqual([25_000]);
    });
  });

  it("cannot be orphaned from its competition, which is why no line can go missing", async () => {
    // The statement LEFT-joins registration and competition so a line is never DROPPED, and this
    // test pins the two database facts that currently make that branch unreachable rather than
    // merely unlikely: `subject_xor` forbids clearing the registration id on a registration-subject
    // payment, and the payment's FK to the registration is NO ACTION, so cascading a competition
    // delete through to the registration is refused while a payment still points at it.
    //
    // Written as a pair of refusals because that is what keeps the LEFT join honest. If either of
    // these ever loosens — a SET NULL added to the FK, the XOR relaxed — this test fails, and the
    // statement's null branch becomes live code that has to render.
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { verifyManualPaymentProof } = await import(
        "@/server/finance/manual-payment-proof-service"
      );
      const { loadInstitutionFeeStatement } = await import("@/server/finance/fee-statement");

      const paymentId = await seedManualPayment(tx, fixture);
      const proofId = await seedProof(tx, fixture, paymentId);
      await verifyManualPaymentProof(fixture.institutionId, fixture.userId, proofId, tx as never, NOW);

      const cleared = await expectRejection(tx, (nested) =>
        nested
          .update(financePayments)
          .set({ competitionRegistrationId: null })
          .where(eq(financePayments.id, paymentId)),
      );
      expect(cleared.code).toBe("23514");
      expect(cleared.constraint).toBe("finance_payments_subject_xor_chk");

      const orphaned = await expectRejection(tx, (nested) =>
        nested.delete(competitions).where(eq(competitions.id, fixture.competitionId)),
      );
      expect(orphaned.code).toBe("23503");

      const statement = await loadInstitutionFeeStatement(fixture.institutionId, tx as never);

      expect(statement.lines).toHaveLength(1);
      expect(statement.lines[0]!.competitionTitle).not.toBeNull();
      expect(statement.outstandingAmount).toBe(25_000);
    });
  });

  it("reports an institution that has charged nobody as owing nothing, not as an error", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { loadInstitutionFeeStatement } = await import("@/server/finance/fee-statement");

      const statement = await loadInstitutionFeeStatement(fixture.institutionId, tx as never);

      expect(statement.lines).toEqual([]);
      expect(statement.acknowledgements).toEqual([]);
      expect(statement.outstandingAmount).toBe(0);
      expect(statement.currency).toBeNull();
    });
  });
});
