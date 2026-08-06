// Platform fee arithmetic. Pure, so the figures a payment snapshots can be asserted without a
// database and cannot drift between the service that writes them and a reader that re-derives them.
//
// The platform never holds the money (DEC-0130): a payer pays into the institution's own gateway
// sub-account and the fee splits at transaction time. What this module computes is therefore the
// SPLIT INSTRUCTION and the record of it — never a balance owed to anyone.
//
// Client-safe: pure, no server-only imports.

import { type CurrencyCode, isMinorUnitAmount } from "@/lib/finance/money";

// Basis points: 1/100th of a percent. 250 = 2.5%. The full range is 0..10000 (0%..100%); the DB
// CHECK pins the same bounds.
const BASIS_POINTS_DENOMINATOR = 10_000;

export type FeeRuleTerms = {
  basisPoints: number;
  flatAmount: number;
  minimumFeeAmount: number | null;
  maximumFeeAmount: number | null;
  currency: CurrencyCode;
};

export type FeeComputation = {
  grossAmount: number;
  platformFeeAmount: number;
  institutionNetAmount: number;
  feeBasisPoints: number;
  feeFlatAmount: number;
  currency: CurrencyCode;
};

export class FeeComputationError extends Error {
  constructor(
    public readonly code:
      | "fee_gross_amount_invalid"
      | "fee_basis_points_invalid"
      | "fee_flat_amount_invalid"
      | "fee_bounds_invalid",
    message: string,
  ) {
    super(message);
    this.name = "FeeComputationError";
  }
}

const assertTerms = (grossAmount: number, terms: FeeRuleTerms): void => {
  if (!isMinorUnitAmount(grossAmount) || grossAmount < 0) {
    throw new FeeComputationError(
      "fee_gross_amount_invalid",
      "Gross amount must be a non-negative integer minor-unit value",
    );
  }

  if (
    !Number.isSafeInteger(terms.basisPoints) ||
    terms.basisPoints < 0 ||
    terms.basisPoints > BASIS_POINTS_DENOMINATOR
  ) {
    throw new FeeComputationError(
      "fee_basis_points_invalid",
      "Fee basis points must be an integer between 0 and 10000",
    );
  }

  if (!isMinorUnitAmount(terms.flatAmount) || terms.flatAmount < 0) {
    throw new FeeComputationError(
      "fee_flat_amount_invalid",
      "Fee flat amount must be a non-negative integer minor-unit value",
    );
  }

  const { minimumFeeAmount, maximumFeeAmount } = terms;

  for (const bound of [minimumFeeAmount, maximumFeeAmount]) {
    if (bound !== null && (!isMinorUnitAmount(bound) || bound < 0)) {
      throw new FeeComputationError(
        "fee_bounds_invalid",
        "Fee bounds must be non-negative integer minor-unit values",
      );
    }
  }

  if (minimumFeeAmount !== null && maximumFeeAmount !== null && minimumFeeAmount > maximumFeeAmount) {
    throw new FeeComputationError(
      "fee_bounds_invalid",
      "Fee minimum cannot exceed fee maximum",
    );
  }
};

/**
 * The platform fee for `grossAmount` under `terms`, and the institution's resulting net.
 *
 * Rounding is FLOOR on the proportional component, which resolves every fraction of a minor unit
 * in the institution's favour. Deliberate: the platform is the party choosing the rounding rule,
 * so it should not be the party the rule benefits. With IDR at exponent 0 the fraction discarded
 * is at most one rupiah per payment.
 *
 * The fee is clamped to `grossAmount` last, after the configured bounds. A flat component or a
 * minimum larger than a small payment would otherwise produce a negative net — money the
 * institution would owe on a sale it made, which no fee rule may express.
 */
export const computePlatformFee = (grossAmount: number, terms: FeeRuleTerms): FeeComputation => {
  assertTerms(grossAmount, terms);

  const proportional = Math.floor((grossAmount * terms.basisPoints) / BASIS_POINTS_DENOMINATOR);
  let fee = proportional + terms.flatAmount;

  if (terms.minimumFeeAmount !== null) {
    fee = Math.max(fee, terms.minimumFeeAmount);
  }

  if (terms.maximumFeeAmount !== null) {
    fee = Math.min(fee, terms.maximumFeeAmount);
  }

  const platformFeeAmount = Math.min(fee, grossAmount);

  return {
    grossAmount,
    platformFeeAmount,
    institutionNetAmount: grossAmount - platformFeeAmount,
    feeBasisPoints: terms.basisPoints,
    feeFlatAmount: terms.flatAmount,
    currency: terms.currency,
  };
};
