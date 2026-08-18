// Presentation helpers for the fee-rule surface, shared by the server page's table and the client
// form's preview so a rate never reads one way in the list and another in the editor.

import { CURRENCY_EXPONENTS, isSupportedCurrency } from "@/lib/finance/money";

// 250 basis points reads as "2,5%" — Indonesian decimal comma, and no trailing ",0" on a whole
// percent. The stored unit is basis points; this is the only place it becomes a percentage.
export const formatBasisPoints = (basisPoints: number): string => {
  const percent = basisPoints / 100;

  return `${percent.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
};

/**
 * A stored minor-unit amount as currency text.
 *
 * Reads the currency's exponent rather than assuming zero: an amount is meaningless without it
 * (see `@/lib/finance/money`), and hard-coding IDR's exponent here is exactly the drift that
 * convention exists to prevent.
 */
export const formatMinorUnits = (amount: number, currency: string): string => {
  const exponent = isSupportedCurrency(currency) ? CURRENCY_EXPONENTS[currency] : 0;
  const major = amount / 10 ** exponent;

  return `${currency} ${major.toLocaleString("id-ID", {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  })}`;
};

export const formatEffectiveDate = (at: Date | string): string =>
  new Date(at).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
