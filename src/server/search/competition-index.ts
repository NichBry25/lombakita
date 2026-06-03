import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/search/competition-index");

// Authoritative schema for the Meilisearch competitions index.
// Imported by: competition-search-sync job and public listing query path.
// Field names defined here must not be scattered as string literals elsewhere.

export const COMPETITION_INDEX_NAME = "competitions" as const;

// Denormalized document stored in Meilisearch. Not the DB CompetitionRow — it includes
// institution fields joined from the institutions table and omits internal DB columns.
// Field mapping from DB:
//   competitions.id                → id
//   competitions.title             → title
//   competitions.slug              → slug
//   competitions.category          → category
//   competitions.mode              → mode
//   competitions.registration_end_at → deadline (UNIX epoch seconds; numeric for range filter support)
//   competitions.created_at        → createdAt
//   competitions.is_featured       → isFeatured
//   competitions.featured_order    → featuredOrder
//   institutions.slug              → institutionSlug
//   institutions.display_name      → institutionName
export type CompetitionIndexDocument = {
  id: string;
  title: string;
  slug: string;
  category: string | null;
  mode: string | null;
  deadline: number | null; // registrationEndAt as UNIX epoch seconds; null = no deadline (never closes)
  createdAt: string; // ISO-8601 string
  isFeatured: boolean;
  featuredOrder: number | null;
  institutionSlug: string;
  institutionName: string;
  status: "published"; // only published records belong in the index
};

export const COMPETITION_INDEX_FILTERABLE_ATTRIBUTES = [
  "category",
  "mode",
  "status",
  "institutionSlug",
  "isFeatured",
  "deadline",
] as const;

export const COMPETITION_INDEX_SORTABLE_ATTRIBUTES = [
  "deadline",
  "createdAt",
  "isFeatured",
  "featuredOrder",
] as const;

export const COMPETITION_INDEX_SEARCHABLE_ATTRIBUTES = ["title", "institutionName"] as const;
