// Money representation for the finance domain. THE ONE PLACE the amount convention is written
// down, so a later multi-currency step cannot misread a stored value.
//
// EVERY monetary amount in this system is an INTEGER COUNT OF THE CURRENCY'S SMALLEST UNIT.
// Never a float, never a decimal. Floating point cannot represent money, and a `numeric` column
// invites a JS consumer to read it as a string and then coerce it.
//
// The smallest unit is defined by the currency's ISO-4217 EXPONENT — the number of decimal places
// the currency subdivides into:
//
//   exponent 0 (IDR)  → the smallest unit IS the rupiah.   50000 means Rp 50.000.
//   exponent 2 (USD)  → the smallest unit is the cent.     50000 would mean $500.00.
//
// So a stored integer is meaningless without the currency stored beside it, which is why every
// amount column in the finance schema is paired with an ISO-4217 currency column even though the
// system transacts in one currency today. Reading an amount without reading its currency is the
// defect this convention exists to prevent.
//
// Client-safe: pure, no server-only imports.

// Currencies this system accepts. IDR alone today. A second entry needs an exponent below and a
// deliberate look at every fee rule already stored, because a rule's amounts are in ITS currency.
export const SUPPORTED_CURRENCIES = ["IDR"] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

// ISO-4217 exponents. IDR is 0: Indonesia transacts in whole rupiah and the sen has not circulated
// for decades, so there is no sub-unit to count.
export const CURRENCY_EXPONENTS: Record<CurrencyCode, number> = {
  IDR: 0,
};

// The ceiling for any single stored amount. Postgres bigint holds far more, but these amounts are
// read into JS `number` (mode: "number" on the bigint columns), so the real limit is the exact
// integer range of a double. Rp 9 quadrillion is roughly 500,000x Indonesia's annual GDP — no
// legitimate single payment approaches it, which is what makes it a usable tripwire rather than a
// business limit.
export const MAX_MINOR_UNIT_AMOUNT = Number.MAX_SAFE_INTEGER;

export const isSupportedCurrency = (value: string): value is CurrencyCode =>
  (SUPPORTED_CURRENCIES as readonly string[]).includes(value);

// A well-formed ISO-4217 alphabetic code. The DB CHECK enforces the same shape; this is the
// application-side half so a bad value is refused before it reaches the database.
export const isIso4217Code = (value: string): boolean => /^[A-Z]{3}$/.test(value);

/**
 * Whether `value` is a storable minor-unit amount: a safe integer within the tripwire ceiling.
 *
 * Sign is NOT checked here. Most amounts must be non-negative, but a compensating correction is
 * legitimately negative, so the sign rule belongs to each caller rather than to the representation.
 */
export const isMinorUnitAmount = (value: number): boolean =>
  Number.isSafeInteger(value) && Math.abs(value) <= MAX_MINOR_UNIT_AMOUNT;
