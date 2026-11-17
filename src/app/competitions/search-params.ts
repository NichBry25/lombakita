import { parseAudienceFilterParam } from "@/lib/competitions/audiences";
import { isCompetitionLocation } from "@/lib/competitions/locations";
import {
  ANY_FEE_FILTER,
  FEE_HIGHEST,
  FEE_LOWEST,
  isFeeRangeNarrowed,
  readFeeFilter,
  type FeeFilter,
  type FeeRange,
} from "@/lib/competitions/fee-range";
import { formatRupiah } from "@/lib/finance/payment-display";
import type { CompetitionAudience } from "@/server/db/schema";
import {
  FULL_TEAM_RANGE,
  TEAM_SIZE_HIGHEST,
  TEAM_SIZE_LOWEST,
  readTeamRange,
  type TeamRange,
} from "@/lib/competitions/team-range";

/**
 * The listing's query string, in one place.
 *
 * The page reads these on the server, the filter row writes them from the client, and the search
 * form carries them through a submit. Three readers of one shape is exactly where a silently
 * dropped parameter comes from, so the shape and the link builder live together here.
 */
export type CompetitionSearchParams = {
  q?: string;
  category?: string;
  mode?: string;
  status?: string;
  teamSize?: string;
  teamMin?: string;
  teamMax?: string;
  location?: string;
  audience?: string;
  fee?: string;
  feeMin?: string;
  feeMax?: string;
  sort?: string;
  page?: string;
};

/**
 * What Next actually hands a page, before anything narrows it.
 *
 * A repeated query parameter (`?q=a&q=b`) arrives as an ARRAY, not a string, and nothing in the
 * type system says so unless the page says so: declaring the fields as `string` compiles and then
 * hands an array to code that calls `.trim()` on it. The route handler at `/api/v1/competitions`
 * never had this problem because `URLSearchParams.get` returns the first value and drops the rest.
 * This is the same shape `institution/[institutionSlug]/audit-log/page.tsx` already declares.
 */
export type RawCompetitionSearchParams = Record<string, string | string[] | undefined>;

/** The first value of a repeated parameter — what `URLSearchParams.get` returns on the API path. */
const firstValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Narrows the raw query string to the shape the rest of the page is written against.
 *
 * One place widens, one place narrows. Every consumer below — the filter row, the link builder,
 * the search form — keeps working with plain strings and cannot be handed an array by surprise.
 */
export const readCompetitionSearchParams = (
  raw: RawCompetitionSearchParams,
): CompetitionSearchParams => ({
  q: firstValue(raw.q),
  category: firstValue(raw.category),
  mode: firstValue(raw.mode),
  status: firstValue(raw.status),
  teamSize: firstValue(raw.teamSize),
  teamMin: firstValue(raw.teamMin),
  teamMax: firstValue(raw.teamMax),
  location: firstValue(raw.location),
  audience: firstValue(raw.audience),
  fee: firstValue(raw.fee),
  feeMin: firstValue(raw.feeMin),
  feeMax: firstValue(raw.feeMax),
  sort: firstValue(raw.sort),
  page: firstValue(raw.page),
});

/** Every filter except the search term, which the search form owns through its own input. */
export const CARRIED_FILTERS = [
  "category",
  "mode",
  "status",
  "teamSize",
  "teamMin",
  "teamMax",
  "location",
  "audience",
  "fee",
  "feeMin",
  "feeMax",
  "sort",
] as const;

/**
 * The query string for `params` with `overrides` applied, without the leading question mark.
 *
 * An override set to `undefined` removes the parameter, which is how a filter is cleared and how a
 * filter change drops the page number it invalidated.
 */
const competitionsQuery = (
  params: CompetitionSearchParams,
  overrides: Partial<CompetitionSearchParams> = {},
): string => {
  const merged = { ...params, ...overrides };
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(merged)) {
    if (value) query.set(key, value);
  }

  return query.toString();
};

/** The listing URL for `params` with `overrides` applied. */
export const competitionsHref = (
  params: CompetitionSearchParams,
  overrides: Partial<CompetitionSearchParams> = {},
): string => {
  const serialized = competitionsQuery(params, overrides);
  return serialized ? `/competitions?${serialized}` : "/competitions";
};

/** The address parameters for a range. An end at the end of the track is left out. */
export const teamRangeToParams = (
  range: TeamRange,
): Pick<CompetitionSearchParams, "teamMin" | "teamMax"> => ({
  teamMin: range.min > TEAM_SIZE_LOWEST ? String(range.min) : undefined,
  teamMax: range.max < TEAM_SIZE_HIGHEST ? String(range.max) : undefined,
});

const describeTeamRangeStart = (size: number): string =>
  size === TEAM_SIZE_LOWEST ? "Individu" : String(size);

const describeTeamSizeEnd = (size: number): string =>
  size === TEAM_SIZE_HIGHEST ? `${TEAM_SIZE_HIGHEST}+` : String(size);

/** What a screen reader says for one handle: "Individu" on 1, "10 atau lebih" at the end of the track. */
export const describeTeamSizeForSpeech = (size: number): string => {
  if (size === TEAM_SIZE_LOWEST) return "Individu";
  return size === TEAM_SIZE_HIGHEST ? `${TEAM_SIZE_HIGHEST} atau lebih` : String(size);
};

/** "Individu" when both ends sit on 1, "Individu sampai 5" from 1, otherwise "2 sampai 4". */
export const describeTeamRange = (range: TeamRange): string => {
  if (range.min === TEAM_SIZE_LOWEST && range.max === TEAM_SIZE_LOWEST) return "Individu";
  return `${describeTeamRangeStart(range.min)} sampai ${describeTeamSizeEnd(range.max)}`;
};

/** The address parameters that clear the fee filter, its two ends included. */
export const CLEAR_FEE_PARAMS: Partial<CompetitionSearchParams> = {
  fee: undefined,
  feeMin: undefined,
  feeMax: undefined,
};

/**
 * The address parameters for a fee filter. An end at the end of the track is left out, so the
 * whole track writes `fee=paid` alone, and Gratis or no filter writes no ends.
 */
export const feeFilterToParams = (fee: FeeFilter): Partial<CompetitionSearchParams> => {
  if (fee.kind === "any") return CLEAR_FEE_PARAMS;
  if (fee.kind === "free") return { ...CLEAR_FEE_PARAMS, fee: "free" };
  return {
    fee: "paid",
    feeMin: fee.min > FEE_LOWEST ? String(fee.min) : undefined,
    feeMax: fee.max < FEE_HIGHEST ? String(fee.max) : undefined,
  };
};

/** "Rp 25.000", or "Rp 250.000+" at the end of the track, where it means this amount or more. */
export const describeFeeAmount = (amount: number): string => {
  const rupiah = formatRupiah(amount, "IDR");
  return amount === FEE_HIGHEST ? `${rupiah}+` : rupiah;
};

/** "Rp 25.000 sampai Rp 250.000+", the slider's words for its range. */
export const describeFeeRange = (range: FeeRange): string =>
  `${describeFeeAmount(range.min)} sampai ${describeFeeAmount(range.max)}`;

const describePaidFee = (fee: FeeRange): string => {
  if (!isFeeRangeNarrowed(fee)) return "Berbayar";
  if (fee.min === FEE_LOWEST) return `sampai ${describeFeeAmount(fee.max)}`;
  if (fee.max === FEE_HIGHEST) return `mulai ${formatRupiah(fee.min, "IDR")}`;
  return describeFeeRange(fee);
};

/** The fee filter in words, "Gratis" or "sampai Rp 100.000", or undefined when none is active. */
export const describeFeeValue = (fee: FeeFilter): string | undefined => {
  if (fee.kind === "free") return "Gratis";
  if (fee.kind === "paid") return describePaidFee(fee);
  return undefined;
};

export const DEFAULT_SORT = "created_desc";

/** The filters a reader sets on the phone sheet, held together until they are applied. */
export type FilterSelection = {
  category: string;
  status: string;
  sort: string;
  teamRange: TeamRange;
  // "" when no location is chosen.
  location: string;
  // The ticked levels. Umum is always shown ticked and is never held here.
  audience: CompetitionAudience[];
  fee: FeeFilter;
};

const readLocationParam = (raw: string | undefined): string =>
  isCompetitionLocation(raw) ? raw : "";

export const readFilterSelection = (params: CompetitionSearchParams): FilterSelection => ({
  category: params.category ?? "",
  status: params.status ?? "",
  sort: params.sort ?? DEFAULT_SORT,
  teamRange: readTeamRange(params),
  location: readLocationParam(params.location),
  audience: parseAudienceFilterParam(params.audience),
  fee: readFeeFilter(params),
});

export const DEFAULT_FILTER_SELECTION: FilterSelection = {
  category: "",
  status: "",
  sort: DEFAULT_SORT,
  teamRange: FULL_TEAM_RANGE,
  location: "",
  audience: [],
  fee: ANY_FEE_FILTER,
};

/** The address parameter for ticked levels, "mahasiswa,smp", or nothing when none are ticked. */
export const audienceToParam = (levels: readonly CompetitionAudience[]): string | undefined =>
  levels.length > 0 ? levels.join(",") : undefined;

/** The old team parameters an address drops the moment a team range is written to it. */
export const DROPPED_TEAM_PARAMS: Partial<CompetitionSearchParams> = {
  mode: undefined,
  teamSize: undefined,
};

/**
 * The address parameters for a selection. It writes only teamMin and teamMax and removes `mode`
 * and `teamSize`, so an old link's filter does not linger beside the range. The default sort is
 * left out, so applying an unchanged selection does not add a sort parameter to the address.
 */
export const selectionToParams = (
  selection: FilterSelection,
): Partial<CompetitionSearchParams> => ({
  category: selection.category || undefined,
  status: selection.status || undefined,
  sort: selection.sort === DEFAULT_SORT ? undefined : selection.sort,
  location: selection.location || undefined,
  audience: audienceToParam(selection.audience),
  ...DROPPED_TEAM_PARAMS,
  ...teamRangeToParams(selection.teamRange),
  ...feeFilterToParams(selection.fee),
});

/** The address parameters that clear the team range, old ones included. */
export const CLEAR_TEAM_RANGE_PARAMS: Partial<CompetitionSearchParams> = {
  ...DROPPED_TEAM_PARAMS,
  teamMin: undefined,
  teamMax: undefined,
};
