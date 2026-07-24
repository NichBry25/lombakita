// Single source of truth for competition category display labels and selection order.
// Imported by both the server-only validation core and client authoring/filter UI, so this
// module must stay free of any server-only imports. The `import type` below is erased at
// compile time and never bundles the DB schema into a client build.
//
// The label record is keyed by CompetitionCategory, so adding a value to the competition_category
// pgEnum (schema.ts) without giving it a label here is a compile error — labels can never silently
// drift from the enum again.
import type { CompetitionCategory } from "@/server/db/schema";
import { formatDisplayToken } from "@/lib/text/capitalize";

export const COMPETITION_CATEGORY_LABELS: Record<CompetitionCategory, string> = {
  hackathon: "Hackathon",
  scientific_writing: "Karya tulis ilmiah (KTI)",
  essay: "Esai",
  debate: "Debat",
  olympiad: "Olimpiade",
  business: "Business",
  engineering: "Engineering",
  finance: "Finance",
  law: "Law",
  design: "UI/UX & desain",
  data_science: "Data science & AI",
  programming: "Pemrograman",
  marketing: "Marketing",
  digital_art: "Digital art",
  infographics: "Infographics",
  performing_arts: "Performance arts",
  esports: "Olahraga & e-sports",
  quiz: "Cerdas cermat",
  other: "Lainnya",
};

// Display and selection order for filters and author forms.
export const COMPETITION_CATEGORY_VALUES: readonly CompetitionCategory[] = [
  "hackathon",
  "scientific_writing",
  "essay",
  "debate",
  "olympiad",
  "business",
  "engineering",
  "finance",
  "law",
  "design",
  "data_science",
  "programming",
  "marketing",
  "digital_art",
  "infographics",
  "performing_arts",
  "esports",
  "quiz",
  "other",
];

export type CompetitionCategoryOption = { value: CompetitionCategory; label: string };

export const COMPETITION_CATEGORY_OPTIONS: readonly CompetitionCategoryOption[] =
  COMPETITION_CATEGORY_VALUES.map((value) => ({
    value,
    label: COMPETITION_CATEGORY_LABELS[value],
  }));

// Resolve a stored category value to its label, falling back to the raw value for any
// unrecognized string (e.g. a legacy value not yet remapped).
export const getCompetitionCategoryLabel = (value: string | null | undefined): string => {
  if (!value) return "";
  return COMPETITION_CATEGORY_LABELS[value as CompetitionCategory] ?? formatDisplayToken(value);
};
