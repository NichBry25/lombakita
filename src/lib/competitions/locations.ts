// Single source of truth for where a competition takes place: labels and order.
// Client-safe (the `import type` is erased at compile time).
import type { CompetitionLocation } from "@/server/db/schema";

export const COMPETITION_LOCATION_LABELS: Record<CompetitionLocation, string> = {
  online: "Online",
  offline: "Offline",
  hybrid: "Hybrid",
};

export const COMPETITION_LOCATION_VALUES: readonly CompetitionLocation[] = [
  "online",
  "offline",
  "hybrid",
];

export type CompetitionLocationOption = { value: CompetitionLocation; label: string };

export const COMPETITION_LOCATION_OPTIONS: readonly CompetitionLocationOption[] =
  COMPETITION_LOCATION_VALUES.map((value) => ({
    value,
    label: COMPETITION_LOCATION_LABELS[value],
  }));

export const isCompetitionLocation = (value: unknown): value is CompetitionLocation =>
  typeof value === "string" && (COMPETITION_LOCATION_VALUES as readonly string[]).includes(value);

export const getCompetitionLocationLabel = (value: string | null | undefined): string => {
  if (!isCompetitionLocation(value)) return "";
  return COMPETITION_LOCATION_LABELS[value];
};
