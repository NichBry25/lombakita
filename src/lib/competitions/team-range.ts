/**
 * The team size range of the competition list, in one place.
 *
 * The page, the filter menus, the chips and the server's query all read the range through this
 * module, so what the slider shows and the rows the server returns come from the same numbers.
 */

export const TEAM_SIZE_LOWEST = 1;

/** The top of the track. As an upper end it means "this size or more". */
export const TEAM_SIZE_HIGHEST = 10;

export type TeamRange = { min: number; max: number };

/** The address parameters that can ask for a team range. `mode` and `teamSize` are the old ones. */
export type TeamRangeParams = {
  teamMin?: string;
  teamMax?: string;
  mode?: string;
  teamSize?: string;
};

export const FULL_TEAM_RANGE: TeamRange = { min: TEAM_SIZE_LOWEST, max: TEAM_SIZE_HIGHEST };

// Links written before the range existed carry one of these words instead of teamMin and teamMax.
const RANGE_OF_MODE: Record<string, TeamRange> = {
  individual: { min: 1, max: 1 },
  team: { min: 2, max: TEAM_SIZE_HIGHEST },
  both: FULL_TEAM_RANGE,
};

const RANGE_OF_TEAM_SIZE: Record<string, TeamRange> = {
  solo: { min: 1, max: 1 },
  small: { min: 2, max: 4 },
  large: { min: 5, max: TEAM_SIZE_HIGHEST },
};

/** A whole number from 1 to 10, or undefined for anything else. */
export const parseTeamBound = (raw: string | undefined): number | undefined => {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const bound = Number.parseInt(raw, 10);
  const isInRange = bound >= TEAM_SIZE_LOWEST && bound <= TEAM_SIZE_HIGHEST;
  return isInRange ? bound : undefined;
};

/** A lower end above the upper end is pulled down to it, because the handles never cross. */
export const normalizeTeamRange = (range: TeamRange): TeamRange => ({
  min: Math.min(range.min, range.max),
  max: range.max,
});

export const isTeamRangeNarrowed = (range: TeamRange): boolean =>
  range.min > TEAM_SIZE_LOWEST || range.max < TEAM_SIZE_HIGHEST;

const overlapOf = (first: TeamRange, second: TeamRange): TeamRange => ({
  min: Math.max(first.min, second.min),
  max: Math.min(first.max, second.max),
});

const readLegacyTeamRange = (params: TeamRangeParams): TeamRange => {
  const fromMode = RANGE_OF_MODE[params.mode ?? ""] ?? FULL_TEAM_RANGE;
  const fromTeamSize = RANGE_OF_TEAM_SIZE[params.teamSize ?? ""] ?? FULL_TEAM_RANGE;
  return overlapOf(fromMode, fromTeamSize);
};

/**
 * The range an address asks for. An absent or unreadable end is the end of the track. When the
 * address has neither teamMin nor teamMax, the old `mode` and `teamSize` parameters are translated
 * into a range instead, so an old shared link shows its filter on the slider and in the chips.
 */
export const readTeamRange = (params: TeamRangeParams): TeamRange => {
  const min = parseTeamBound(params.teamMin);
  const max = parseTeamBound(params.teamMax);
  if (min === undefined && max === undefined) {
    return normalizeTeamRange(readLegacyTeamRange(params));
  }
  return normalizeTeamRange({ min: min ?? TEAM_SIZE_LOWEST, max: max ?? TEAM_SIZE_HIGHEST });
};
