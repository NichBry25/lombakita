import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/fee-accrual-service");

import { and, eq, sum } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  financeFeeAccruals,
  financeFeeRules,
  financePayments,
  type FinanceFeeAccrualRecord,
} from "@/server/db/schema";
import { computePlatformFee } from "@/lib/finance/fee";
import { toFeeRuleTerms } from "@/server/finance/fee-rule-service";

// WHAT AN INSTITUTION OWES THE PLATFORM on the manual lane, and the only code that writes it.
//
// On the gateway lane the platform fee splits at transaction time and `finance_payments` records
// the split directly. On the manual lane the payer transfers the whole amount to the institution's
// own account — nothing splits, the payment row truthfully records fee 0 / net = gross, and the
// platform's fee becomes a DEBT the institution owes separately. This module records that debt.
//
// NOT A BALANCE TABLE (see the table's own docblock). It records money owed TO the platform, which
// is the opposite direction to the custody DEC-0130 forbids. Nothing here may ever grow a column
// meaning "owed to the institution", a running total, or a settled/unsettled pair used as a wallet.
//
// APPEND-ONLY. There is no update path and no delete path, and there must never be one: a fee
// walked back is a compensating `reversed` row carrying its own reason.

export type FeeAccrualErrorCode =
  | "fee_accrual_payment_not_found"
  | "fee_accrual_not_manual_lane"
  | "fee_accrual_rule_missing"
  | "fee_accrual_already_recorded"
  | "fee_accrual_reason_required"
  | "fee_accrual_nothing_to_reverse";

export class FeeAccrualError extends Error {
  constructor(
    public readonly code: FeeAccrualErrorCode,
    message: string,
    public readonly status: number = 422,
  ) {
    super(message);
    this.name = "FeeAccrualError";
  }
}

const UNIQUE_VIOLATION = "23505";
const ACCRUED_UNIQUE_INDEX = "finance_fee_accruals_payment_accrued_unique_idx";

const isDuplicateAccrual = (error: unknown): boolean => {
  let current: unknown = error;

  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as {
      code?: string;
      // postgres-js reports a violated UNIQUE INDEX under `constraint_name`, not `constraint` —
      // reading only the latter matches nothing, and the duplicate branch silently never fires.
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (candidate.code === UNIQUE_VIOLATION) {
      const name = candidate.constraint_name ?? candidate.constraint ?? "";
      return name.includes(ACCRUED_UNIQUE_INDEX);
    }
    current = candidate.cause;
  }

  return false;
};

/**
 * Records the fee an institution owes on one confirmed manual-lane payment.
 *
 * MUST be called inside the transaction that transitioned the proof row, and only by the CAS
 * winner. Two guarantees stack, deliberately:
 *
 *   1. The caller's optimistic CAS on the proof's status means only one concurrent verification
 *      reaches this function at all. That is the guard that stops the second click.
 *   2. The partial unique index on the `accrued` arm means that even if a future caller forgets
 *      (1), Postgres refuses the second row. A service read-then-write cannot make that promise:
 *      the platform idempotency arm mints a fresh UUID per call BY DESIGN, so two clicks produce
 *      two legitimate `succeeded` events. The fold tolerates a duplicate success; a doubled fee is
 *      money.
 *
 * The rule is loaded BY THE ID THE PAYMENT SNAPSHOTTED, never re-resolved by date. Re-resolving
 * would let a rule inserted after the fact price a payment retroactively, which is the exact
 * failure the Step 7.1 snapshot exists to prevent.
 */
export const recordFeeAccrual = async (
  paymentId: string,
  db: Database = getDb(),
): Promise<FinanceFeeAccrualRecord> => {
  const [payment] = await db
    .select()
    .from(financePayments)
    .where(eq(financePayments.id, paymentId))
    .limit(1);

  if (!payment) {
    throw new FeeAccrualError("fee_accrual_payment_not_found", "Payment not found", 404);
  }

  if (payment.origin !== "manual_transfer") {
    // A gateway payment's fee already moved apart at transaction time and is recorded on the
    // payment row. Accruing it again would bill the institution twice for one fee.
    throw new FeeAccrualError(
      "fee_accrual_not_manual_lane",
      "Only a manual-transfer payment accrues a fee — a gateway payment's fee split at transaction time",
    );
  }

  const [rule] = await db
    .select()
    .from(financeFeeRules)
    .where(eq(financeFeeRules.id, payment.feeRuleId))
    .limit(1);

  if (!rule) {
    // Unreachable through any supported path: the fee-rule foreign key carries NO ACTION, so the
    // delete that would cause this is refused by the database.
    throw new FeeAccrualError(
      "fee_accrual_rule_missing",
      `Payment ${paymentId} names fee rule ${payment.feeRuleId}, which no longer exists`,
    );
  }

  const fee = computePlatformFee(payment.grossAmount, toFeeRuleTerms(rule));

  try {
    const [created] = await db
      .insert(financeFeeAccruals)
      .values({
        paymentId: payment.id,
        owingInstitutionId: payment.receivingInstitutionId,
        entryType: "accrued",
        currency: payment.currency,
        amount: fee.platformFeeAmount,
        feeRuleId: rule.id,
        feeBasisPoints: fee.feeBasisPoints,
        feeFlatAmount: fee.feeFlatAmount,
        grossAmount: payment.grossAmount,
      })
      .returning();

    if (!created) {
      throw new FeeAccrualError("fee_accrual_rule_missing", "Fee accrual could not be recorded");
    }

    return created;
  } catch (error) {
    if (isDuplicateAccrual(error)) {
      throw new FeeAccrualError(
        "fee_accrual_already_recorded",
        `Payment ${paymentId} has already accrued its platform fee`,
        409,
      );
    }
    throw error;
  }
};

/**
 * Walks an accrual back with a compensating row.
 *
 * Deliberately UNCONSTRAINED in count — a figure may need correcting more than once — which is why
 * the unique index is partial on the `accrued` arm rather than covering the table. The reason is
 * mandatory here and at the database, because a fee removed without a stated why is the one thing
 * an auditor cannot reconstruct afterwards.
 */
export const recordFeeAccrualReversal = async (
  paymentId: string,
  reason: string,
  db: Database = getDb(),
): Promise<FinanceFeeAccrualRecord> => {
  if (reason.trim().length === 0) {
    throw new FeeAccrualError("fee_accrual_reason_required", "A reversal must state its reason");
  }

  const [accrued] = await db
    .select()
    .from(financeFeeAccruals)
    .where(
      and(eq(financeFeeAccruals.paymentId, paymentId), eq(financeFeeAccruals.entryType, "accrued")),
    )
    .limit(1);

  if (!accrued) {
    throw new FeeAccrualError(
      "fee_accrual_nothing_to_reverse",
      `Payment ${paymentId} has no accrued fee to reverse`,
      404,
    );
  }

  const [created] = await db
    .insert(financeFeeAccruals)
    .values({
      paymentId: accrued.paymentId,
      owingInstitutionId: accrued.owingInstitutionId,
      entryType: "reversed",
      currency: accrued.currency,
      // Negated, so the institution's outstanding fee is the SUM of its rows and never needs a
      // second column recording which rows are "still open".
      amount: -accrued.amount,
      feeRuleId: accrued.feeRuleId,
      feeBasisPoints: accrued.feeBasisPoints,
      feeFlatAmount: accrued.feeFlatAmount,
      grossAmount: accrued.grossAmount,
      reason: reason.trim(),
    })
    .returning();

  if (!created) {
    throw new FeeAccrualError("fee_accrual_rule_missing", "Fee reversal could not be recorded");
  }

  return created;
};

/**
 * What one institution currently owes: the signed SUM of its accrual rows.
 *
 * DERIVED, never stored. A stored total is a second copy of a fact these rows already carry, and
 * the two disagree the first time a write half-fails — which in a financial system is the moment
 * the copy is trusted most. This is the same argument that keeps a status column off
 * `finance_payments`, and it is why summing here does not make this a balance table: there is
 * nothing to reconcile against.
 */
export const sumOutstandingFeeAccruals = async (
  institutionId: string,
  db: Database = getDb(),
): Promise<number> => {
  const [row] = await db
    .select({ total: sum(financeFeeAccruals.amount) })
    .from(financeFeeAccruals)
    .where(eq(financeFeeAccruals.owingInstitutionId, institutionId));

  // `sum()` returns a numeric string, and null over an empty set.
  return row?.total === null || row?.total === undefined ? 0 : Number(row.total);
};
