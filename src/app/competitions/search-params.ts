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
  sort: firstValue(raw.sort),
  page: firstValue(raw.page),
});

/** Every filter except the search term, which the search form owns through its own input. */
export const CARRIED_FILTERS = ["category", "mode", "status", "teamSize", "sort"] as const;

/**
 * The listing URL for `params` with `overrides` applied.
 *
 * An override set to `undefined` removes the parameter, which is how a filter is cleared and how a
 * filter change drops the page number it invalidated.
 */
export const competitionsHref = (
  params: CompetitionSearchParams,
  overrides: Partial<CompetitionSearchParams> = {},
): string => {
  const merged = { ...params, ...overrides };
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(merged)) {
    if (value) query.set(key, value);
  }

  const serialized = query.toString();
  return serialized ? `/competitions?${serialized}` : "/competitions";
};
