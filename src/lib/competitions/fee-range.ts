/**
 * The fee filter of the competition list, in one place.
 *
 * The page, the filter menus, the chips and the server's query all read the fee filter through this
 * module, so what the slider shows and the rows the server returns come from the same numbers.
 * Amounts here are whole rupiah, the unit the slider speaks.
 */

/** The bottom of the track. As a lower end it means "free competitions are included". */
export const FEE_LOWEST = 0;

/** The top of the track. As an upper end it means "this amount or more". */
export const FEE_HIGHEST = 250_000;

export const FEE_STEP = 25_000;

export type FeeRange = { min: number; max: number };

/** The address parameters that can ask for a fee filter. */
export type FeeRangeParams = {
  feeMin?: string;
  feeMax?: string;
};

export const FULL_FEE_RANGE: FeeRange = { min: FEE_LOWEST, max: FEE_HIGHEST };

/** A whole number from 0 to 250000 on a step of 25000, or undefined for anything else. */
export const parseFeeBound = (raw: string | undefined): number | undefined => {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const bound = Number.parseInt(raw, 10);
  const isInRange = bound >= FEE_LOWEST && bound <= FEE_HIGHEST;
  const isOnStep = bound % FEE_STEP === 0;
  return isInRange && isOnStep ? bound : undefined;
};

/** A lower end above the upper end is pulled down to it, because the handles never cross. */
export const normalizeFeeRange = (range: FeeRange): FeeRange => ({
  min: Math.min(range.min, range.max),
  max: range.max,
});

export const isFeeRangeNarrowed = (range: FeeRange): boolean =>
  range.min > FEE_LOWEST || range.max < FEE_HIGHEST;

/** The range an address asks for. An absent or unreadable end is the end of the track. */
export const readFeeRange = (params: FeeRangeParams): FeeRange => {
  const min = parseFeeBound(params.feeMin) ?? FEE_LOWEST;
  const max = parseFeeBound(params.feeMax) ?? FEE_HIGHEST;
  return normalizeFeeRange({ min, max });
};
