/**
 * The fee filter of the competition list, in one place.
 *
 * The page, the filter menus, the chips and the server's query all read the fee filter through this
 * module, so what the slider shows and the rows the server returns come from the same numbers.
 * Amounts here are whole rupiah, the unit the slider speaks.
 */

export const FEE_LOWEST = 0;

/** The top of the track. As an upper end it means "this amount or more". */
export const FEE_HIGHEST = 250_000;

export const FEE_STEP = 25_000;

/** The lowest value the upper handle can take: a range that ends at 0 would match nothing. */
export const FEE_UPPER_END_LOWEST = FEE_STEP;

export type FeeRange = { min: number; max: number };

/** The address parameters that can ask for a fee filter. */
export type FeeFilterParams = {
  fee?: string;
  feeMin?: string;
  feeMax?: string;
};

export type FeeFilter =
  | { kind: "any" }
  | { kind: "free" }
  | { kind: "paid"; min: number; max: number };

export const FULL_FEE_RANGE: FeeRange = { min: FEE_LOWEST, max: FEE_HIGHEST };

export const ANY_FEE_FILTER: FeeFilter = { kind: "any" };

const parseFeeStep = (raw: string | undefined, lowest: number): number | undefined => {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const amount = Number.parseInt(raw, 10);
  const isInRange = amount >= lowest && amount <= FEE_HIGHEST;
  const isOnStep = amount % FEE_STEP === 0;
  return isInRange && isOnStep ? amount : undefined;
};

/** A whole number of rupiah from 0 to 250000 on a step of 25000, or undefined for anything else. */
export const parseFeeMin = (raw: string | undefined): number | undefined =>
  parseFeeStep(raw, FEE_LOWEST);

/** Like parseFeeMin but from 25000, so a 0 upper end is read as an open end. */
export const parseFeeMax = (raw: string | undefined): number | undefined =>
  parseFeeStep(raw, FEE_UPPER_END_LOWEST);

/** A lower end above the upper end is pulled down to it, because the handles never cross. */
export const normalizeFeeRange = (range: FeeRange): FeeRange => ({
  min: Math.min(range.min, range.max),
  max: range.max,
});

export const isFeeRangeNarrowed = (range: FeeRange): boolean =>
  range.min > FEE_LOWEST || range.max < FEE_HIGHEST;

/**
 * The fee filter an address asks for. Only `fee=free` and `fee=paid` ask for anything. The two
 * ends count only with `fee=paid`, and an absent or unreadable end is the end of the track.
 */
export const readFeeFilter = (params: FeeFilterParams): FeeFilter => {
  if (params.fee === "free") return { kind: "free" };
  if (params.fee !== "paid") return ANY_FEE_FILTER;
  const min = parseFeeMin(params.feeMin) ?? FEE_LOWEST;
  const max = parseFeeMax(params.feeMax) ?? FEE_HIGHEST;
  return { kind: "paid", ...normalizeFeeRange({ min, max }) };
};
