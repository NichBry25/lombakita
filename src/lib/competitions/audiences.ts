// Single source of truth for who a competition is meant for: labels, the fixed display order and
// how a list of values is normalized. The audience is a label only and never gates registration
// (DEC-0106). Client-safe (the `import type` is erased at compile time).
import type { CompetitionAudience } from "@/server/db/schema";

export const COMPETITION_AUDIENCE_LABELS: Record<CompetitionAudience, string> = {
  umum: "Umum",
  mahasiswa: "Mahasiswa",
  sma_smk: "SMA/SMK",
  smp: "SMP",
  sd: "SD",
};

// The one order every list of audiences is stored and shown in.
export const COMPETITION_AUDIENCE_VALUES: readonly CompetitionAudience[] = [
  "umum",
  "mahasiswa",
  "sma_smk",
  "smp",
  "sd",
];

export type CompetitionAudienceOption = { value: CompetitionAudience; label: string };

export const COMPETITION_AUDIENCE_OPTIONS: readonly CompetitionAudienceOption[] =
  COMPETITION_AUDIENCE_VALUES.map((value) => ({
    value,
    label: COMPETITION_AUDIENCE_LABELS[value],
  }));

export const isCompetitionAudience = (value: unknown): value is CompetitionAudience =>
  typeof value === "string" && (COMPETITION_AUDIENCE_VALUES as readonly string[]).includes(value);

// Drops duplicates and puts the values in the fixed order. An empty result is null, because an
// empty audience is stored as NULL and never as an empty array.
export const normalizeAudience = (
  values: readonly CompetitionAudience[],
): CompetitionAudience[] | null => {
  const ordered = COMPETITION_AUDIENCE_VALUES.filter((value) => values.includes(value));
  return ordered.length > 0 ? ordered : null;
};

export const formatAudienceLabels = (values: readonly CompetitionAudience[] | null): string => {
  if (!values || values.length === 0) return "";
  const ordered = normalizeAudience(values) ?? [];
  return ordered.map((value) => COMPETITION_AUDIENCE_LABELS[value]).join(", ");
};

// The levels a filter narrows by. Umum is always included in the results, so ticking it adds no
// restriction and is left out; unknown values are dropped.
export const audienceFilterLevels = (values: readonly string[]): CompetitionAudience[] => {
  const known = values.filter(isCompetitionAudience);
  const levels = known.filter((value) => value !== "umum");
  return normalizeAudience(levels) ?? [];
};

// An address parameter holds the ticked values comma separated, for example "mahasiswa,smp".
export const parseAudienceFilterParam = (raw: string | undefined): CompetitionAudience[] => {
  if (!raw) return [];
  return audienceFilterLevels(raw.split(",").map((part) => part.trim()));
};
