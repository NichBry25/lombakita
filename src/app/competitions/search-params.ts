import { parseAudienceFilterParam } from "@/lib/competitions/audiences";
import { isCompetitionLocation } from "@/lib/competitions/locations";
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
  "sort",
] as const;

/**
 * The query string for `params` with `overrides` applied, without the leading question mark.
 *
 * An override set to `undefined` removes the parameter, which is how a filter is cleared and how a
 * filter change drops the page number it invalidated.
 */
export const competitionsQuery = (
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

const describeTeamSizeEnd = (size: number): string =>
  size === TEAM_SIZE_HIGHEST ? `${TEAM_SIZE_HIGHEST}+` : String(size);

/** What a screen reader says for one handle: "10 atau lebih" at the end of the track. */
export const describeTeamSizeForSpeech = (size: number): string =>
  size === TEAM_SIZE_HIGHEST ? `${TEAM_SIZE_HIGHEST} atau lebih` : String(size);

/** "Individu" when both ends sit on 1, otherwise "2 sampai 4". */
export const describeTeamRange = (range: TeamRange): string => {
  if (range.min === TEAM_SIZE_LOWEST && range.max === TEAM_SIZE_LOWEST) return "Individu";
  return `${describeTeamSizeEnd(range.min)} sampai ${describeTeamSizeEnd(range.max)}`;
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
});

export const DEFAULT_FILTER_SELECTION: FilterSelection = {
  category: "",
  status: "",
  sort: DEFAULT_SORT,
  teamRange: FULL_TEAM_RANGE,
  location: "",
  audience: [],
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
 * and `teamSize`, so an old link's filter does not linger beside the range.
 */
export const selectionToParams = (
  selection: FilterSelection,
): Partial<CompetitionSearchParams> => ({
  category: selection.category || undefined,
  status: selection.status || undefined,
  sort: selection.sort || undefined,
  location: selection.location || undefined,
  audience: audienceToParam(selection.audience),
  ...DROPPED_TEAM_PARAMS,
  ...teamRangeToParams(selection.teamRange),
});

/** The address parameters that clear the team range, old ones included. */
export const CLEAR_TEAM_RANGE_PARAMS: Partial<CompetitionSearchParams> = {
  ...DROPPED_TEAM_PARAMS,
  teamMin: undefined,
  teamMax: undefined,
};
