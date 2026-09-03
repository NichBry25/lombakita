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
