// Pure utility for team-size display text. Collapsed to a single number when min === max.
export const formatTeamSizeText = (min: number | null, max: number | null): string => {
  if (min !== null && max !== null) {
    return min === max ? `${min} orang` : `${min}–${max} orang`;
  }
  if (min !== null) return `Min. ${min} orang`;
  if (max !== null) return `Maks. ${max} orang`;
  return "";
};
