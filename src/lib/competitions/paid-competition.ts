// Whether a competition charges for registration — THE one definition, for every caller.
//
// This replaces two byte-identical private copies (registration-service.ts and
// team-registration-service.ts) that each parsed the old `numeric` column with
// `Number.parseFloat`. That parse was the reason the duplication was dangerous rather than merely
// untidy: `fee_amount` is now an integer count of the currency's smallest unit
// (@/lib/finance/money), so a float parse is no longer the right reading of the column, and fixing
// it in one copy while missing the other would leave two services disagreeing about whether the
// same competition is free.
//
// Client-safe: pure, no server-only imports.

import { isMinorUnitAmount } from "@/lib/finance/money";

/**
 * True when this competition charges a registration fee.
 *
 * A NULL fee and a zero fee are BOTH free, and are deliberately not distinguished: "no fee set"
 * and "the fee is nothing" mean the same thing to a candidate at the point of registering.
 *
 * A non-integer or unsafe value is treated as FREE rather than paid. That is the fail-safe
 * direction: the alternative would let a corrupt value switch a competition into the paid lane,
 * where it would demand money under a figure nothing else in the stack can interpret. The database
 * CHECK makes this branch unreachable through any supported write path; it exists because this
 * predicate gates money and must not depend on that remaining true.
 */
export const isPaidCompetition = (feeAmount: number | null | undefined): boolean => {
  if (feeAmount === null || feeAmount === undefined) return false;
  if (!isMinorUnitAmount(feeAmount)) return false;
  return feeAmount > 0;
};
