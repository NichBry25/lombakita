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

/**
 * The team size range runs from 1 (individual) to 10, and 10 means "10 or more". The server reads
 * the same bounds in competition-public-service.ts.
 */
export const TEAM_SIZE_LOWEST = 1;
export const TEAM_SIZE_HIGHEST = 10;

export type TeamRange = { min: number; max: number };

const parseTeamBound = (raw: string | undefined): number | undefined => {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const bound = Number.parseInt(raw, 10);
  const isInRange = bound >= TEAM_SIZE_LOWEST && bound <= TEAM_SIZE_HIGHEST;
  return isInRange ? bound : undefined;
};

/**
 * The range the address asks for, with an absent or unreadable end at the end of the track. A
 * lower end above the upper end is pulled down to it, because the handles never cross.
 */
export const readTeamRange = (params: CompetitionSearchParams): TeamRange => {
  const max = parseTeamBound(params.teamMax) ?? TEAM_SIZE_HIGHEST;
  const min = Math.min(parseTeamBound(params.teamMin) ?? TEAM_SIZE_LOWEST, max);
  return { min, max };
};

export const isTeamRangeNarrowed = (range: TeamRange): boolean =>
  range.min > TEAM_SIZE_LOWEST || range.max < TEAM_SIZE_HIGHEST;

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
};

export const readFilterSelection = (params: CompetitionSearchParams): FilterSelection => ({
  category: params.category ?? "",
  status: params.status ?? "",
  sort: params.sort ?? DEFAULT_SORT,
  teamRange: readTeamRange(params),
});

export const DEFAULT_FILTER_SELECTION: FilterSelection = {
  category: "",
  status: "",
  sort: DEFAULT_SORT,
  teamRange: { min: TEAM_SIZE_LOWEST, max: TEAM_SIZE_HIGHEST },
};

/**
 * The address parameters for a selection. A team range replaces a `teamSize` word from an old
 * link, so that link's filter does not linger beside the range.
 */
export const selectionToParams = (
  selection: FilterSelection,
): Partial<CompetitionSearchParams> => ({
  category: selection.category || undefined,
  status: selection.status || undefined,
  sort: selection.sort || undefined,
  teamSize: undefined,
  ...teamRangeToParams(selection.teamRange),
});
