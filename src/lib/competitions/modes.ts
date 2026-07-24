// Single source of truth for competition mode display labels. Client-safe (the `import type`
// is erased at compile time). Labels are capitalized per the single-word display rule.
import type { CompetitionMode } from "@/server/db/schema";
import { formatDisplayToken } from "@/lib/text/capitalize";

export const COMPETITION_MODE_LABELS: Record<CompetitionMode, string> = {
  individual: "Individu",
  team: "Tim",
  both: "Individu / Tim",
};

export const COMPETITION_MODE_VALUES: readonly CompetitionMode[] = ["individual", "team", "both"];

export type CompetitionModeOption = { value: CompetitionMode; label: string };

export const COMPETITION_MODE_OPTIONS: readonly CompetitionModeOption[] =
  COMPETITION_MODE_VALUES.map((value) => ({ value, label: COMPETITION_MODE_LABELS[value] }));

export const getCompetitionModeLabel = (value: string | null | undefined): string => {
  if (!value) return "";
  return COMPETITION_MODE_LABELS[value as CompetitionMode] ?? formatDisplayToken(value);
};
