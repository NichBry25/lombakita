// Client-safe controlled tag vocabulary. The stored value IS the display label. Imported by both
// the server-only validation core and the client authoring UI, so this module must stay free of
// any server-only imports.
export const ALLOWED_COMPETITION_TAGS = [
  "Pemrograman",
  "Data & AI",
  "UI/UX",
  "Desain",
  "Bisnis",
  "Pemasaran",
  "Manajemen Produk",
  "Kewirausahaan",
  "Riset",
  "Esai",
  "Debat",
  "Fotografi",
  "Film",
  "Hackathon",
  "Olimpiade",
  "Presentasi",
  "Kuis",
] as const;

export type CompetitionTag = (typeof ALLOWED_COMPETITION_TAGS)[number];
