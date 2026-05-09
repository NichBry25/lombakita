import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-public-service");

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions, institutions, type CompetitionCategory, type CompetitionMode } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { getMeilisearchClient } from "@/server/search/client";
import { isMeilisearchAvailable } from "@/server/search/availability";
import {
  COMPETITION_INDEX_NAME,
  type CompetitionIndexDocument,
} from "@/server/search/competition-index";
import {
  isCompetitionCategory,
  isCompetitionMode,
} from "@/server/competitions/competition-core";

// Public listing columns — includes institution display name joined from the institutions table.
// Does not expose fee_amount, fee_currency, or is_featured (DEC-0022).
const PUBLIC_LISTING_COLUMNS = {
  id: competitions.id,
  slug: competitions.slug,
  title: competitions.title,
  description: competitions.description,
  category: competitions.category,
  mode: competitions.mode,
  minTeamSize: competitions.minTeamSize,
  maxTeamSize: competitions.maxTeamSize,
  registrationStartAt: competitions.registrationStartAt,
  registrationEndAt: competitions.registrationEndAt,
  eventStartAt: competitions.eventStartAt,
  eventEndAt: competitions.eventEndAt,
  publishedAt: competitions.publishedAt,
  createdAt: competitions.createdAt,
  updatedAt: competitions.updatedAt,
  institutionSlug: institutions.slug,
  institutionName: institutions.displayName,
} as const;

export type PublicCompetitionItem = {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: CompetitionCategory | null;
  mode: CompetitionMode | null;
  minTeamSize: number | null;
  maxTeamSize: number | null;
  registrationStartAt: Date | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  eventEndAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  institutionSlug: string;
  institutionName: string;
};

export type PublicListingSort = "deadline_asc" | "deadline_desc" | "created_desc";

export type PublicListingFilters = {
  q?: string;
  category?: string;
  mode?: string;
  institutionSlug?: string;
  sort?: string;
  page?: number;
  limit?: number;
};

export type PublicListingResult = {
  data: PublicCompetitionItem[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    searchEngine: "meilisearch" | "db";
  };
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const resolveSort = (raw: string | undefined): PublicListingSort => {
  if (raw === "deadline_asc" || raw === "deadline_desc" || raw === "created_desc") return raw;
  return "created_desc";
};

const resolveLimit = (raw: number | undefined): number => {
  if (!raw || !Number.isFinite(raw) || raw < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(raw, MAX_PAGE_SIZE);
};

const resolvePage = (raw: number | undefined): number => {
  if (!raw || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
};

const buildDbOrderBy = (sort: PublicListingSort) => {
  if (sort === "deadline_asc") return asc(competitions.registrationEndAt);
  if (sort === "deadline_desc") return desc(competitions.registrationEndAt);
  return desc(competitions.createdAt); // created_desc default
};

const buildDbWhere = (filters: PublicListingFilters) => {
  const conditions = [
    eq(competitions.status, "published"),
    isNull(competitions.deletedAt),
  ];

  if (filters.category && isCompetitionCategory(filters.category)) {
    conditions.push(eq(competitions.category, filters.category));
  }
  if (filters.mode && isCompetitionMode(filters.mode)) {
    conditions.push(eq(competitions.mode, filters.mode));
  }
  if (filters.institutionSlug) {
    conditions.push(eq(institutions.slug, filters.institutionSlug.trim().toLowerCase()));
  }

  return and(...conditions);
};

const listFromDb = async (
  filters: PublicListingFilters,
  db: Database,
): Promise<PublicListingResult> => {
  const sort = resolveSort(filters.sort);
  const limit = resolveLimit(filters.limit);
  const page = resolvePage(filters.page);
  const offset = (page - 1) * limit;

  const where = buildDbWhere(filters);
  const orderBy = buildDbOrderBy(sort);

  const rows = await db
    .select(PUBLIC_LISTING_COLUMNS)
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(where)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(where);

  const total = countRow?.count ?? 0;

  return {
    data: rows as PublicCompetitionItem[],
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      searchEngine: "db",
    },
  };
};

const listFromMeilisearch = async (
  filters: PublicListingFilters,
  db: Database,
): Promise<PublicListingResult> => {
  const sort = resolveSort(filters.sort);
  const limit = resolveLimit(filters.limit);
  const page = resolvePage(filters.page);
  const offset = (page - 1) * limit;

  const client = getMeilisearchClient();
  const index = client.index<CompetitionIndexDocument>(COMPETITION_INDEX_NAME);

  // Build Meilisearch filter expression
  const filterParts: string[] = ['status = "published"'];
  if (filters.category && isCompetitionCategory(filters.category)) {
    filterParts.push(`category = "${filters.category}"`);
  }
  if (filters.mode && isCompetitionMode(filters.mode)) {
    filterParts.push(`mode = "${filters.mode}"`);
  }
  if (filters.institutionSlug) {
    filterParts.push(`institutionSlug = "${filters.institutionSlug.trim().toLowerCase()}"`);
  }

  // Build Meilisearch sort expression
  let meiliSort: string[] | undefined;
  if (sort === "deadline_asc") meiliSort = ["deadline:asc"];
  else if (sort === "deadline_desc") meiliSort = ["deadline:desc"];
  else meiliSort = ["createdAt:desc"];

  const searchResult = await index.search(filters.q ?? "", {
    filter: filterParts.join(" AND "),
    sort: meiliSort,
    limit,
    offset,
  });

  const ids = searchResult.hits.map((h) => h.id);
  const total = searchResult.estimatedTotalHits ?? 0;

  if (ids.length === 0) {
    return {
      data: [],
      meta: { total, page, limit, totalPages: Math.ceil(total / limit), searchEngine: "meilisearch" },
    };
  }

  // Hydrate from DB — re-apply status = published guard so Meilisearch results are not
  // trusted as the source of truth for status. A competition unpublished between indexing
  // and query execution will be filtered out here.
  const rows = await db
    .select(PUBLIC_LISTING_COLUMNS)
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitions.status, "published"),
        isNull(competitions.deletedAt),
        inArray(competitions.id, ids),
      ),
    );

  // Preserve Meilisearch result order.
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => rowById.get(id)).filter(Boolean) as PublicCompetitionItem[];

  return {
    data: ordered,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit), searchEngine: "meilisearch" },
  };
};

export const listPublicCompetitions = async (
  filters: PublicListingFilters,
  db: Database = getDb(),
): Promise<PublicListingResult> => {
  const useSearch = Boolean(filters.q) && isMeilisearchAvailable();

  // TODO(debug): remove after diagnosing Vercel env var issue
  console.log("[DEBUG listPublicCompetitions] q:", filters.q, "| useSearch:", useSearch);

  if (useSearch) {
    try {
      // TODO(debug): remove after diagnosing Vercel env var issue
      console.log("[DEBUG listPublicCompetitions] taking MEILISEARCH path");
      return await listFromMeilisearch(filters, db);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // TODO(debug): remove after diagnosing Vercel env var issue
      console.log("[DEBUG listPublicCompetitions] Meilisearch threw:", errorMessage);
      // Meilisearch unavailable at runtime — degrade transparently to DB query.
      logger.warn("competition-public-listing.meilisearch-fallback", {
        reason: errorMessage,
        q: filters.q,
      });
    }
  } else if (filters.q && !isMeilisearchAvailable()) {
    // q was supplied but Meilisearch is not configured — degrade transparently to DB query.
    // Log so the missing credentials are observable.
    logger.warn("competition-public-listing.meilisearch-unavailable", {
      reason: "MEILISEARCH_HOST not configured",
      q: filters.q,
    });
  }

  // TODO(debug): remove after diagnosing Vercel env var issue
  console.log("[DEBUG listPublicCompetitions] taking DB path");

  return listFromDb(filters, db);
};

// ── Detail ────────────────────────────────────────────────────────────────────

export type RegistrationCTAState = "open" | "closed" | "not_yet_open";

export const deriveCTAState = (
  startAt: Date | null,
  endAt: Date | null,
  now: Date = new Date(),
): RegistrationCTAState => {
  if (!startAt || !endAt) return "closed";
  if (now < startAt) return "not_yet_open";
  if (now <= endAt) return "open";
  return "closed";
};

const PUBLIC_DETAIL_COLUMNS = {
  id: competitions.id,
  slug: competitions.slug,
  title: competitions.title,
  description: competitions.description,
  category: competitions.category,
  mode: competitions.mode,
  minTeamSize: competitions.minTeamSize,
  maxTeamSize: competitions.maxTeamSize,
  registrationStartAt: competitions.registrationStartAt,
  registrationEndAt: competitions.registrationEndAt,
  eventStartAt: competitions.eventStartAt,
  eventEndAt: competitions.eventEndAt,
  feeAmount: competitions.feeAmount,
  publishedAt: competitions.publishedAt,
  institutionSlug: institutions.slug,
  institutionName: institutions.displayName,
} as const;

export type PublicCompetitionDetail = {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: CompetitionCategory | null;
  mode: CompetitionMode | null;
  minTeamSize: number | null;
  maxTeamSize: number | null;
  registrationStartAt: Date | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  eventEndAt: Date | null;
  feeAmount: string | null;
  publishedAt: Date | null;
  organizer: {
    slug: string;
    name: string;
    logoUrl: string | null;
  };
  ctaState: RegistrationCTAState;
};

export const getPublicCompetitionDetail = async (
  institutionSlug: string,
  competitionSlug: string,
  db: Database = getDb(),
): Promise<PublicCompetitionDetail | null> => {
  const [row] = await db
    .select(PUBLIC_DETAIL_COLUMNS)
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitions.status, "published"),
        isNull(competitions.deletedAt),
        eq(competitions.slug, competitionSlug),
        eq(institutions.slug, institutionSlug),
      ),
    );

  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    category: row.category,
    mode: row.mode,
    minTeamSize: row.minTeamSize,
    maxTeamSize: row.maxTeamSize,
    registrationStartAt: row.registrationStartAt,
    registrationEndAt: row.registrationEndAt,
    eventStartAt: row.eventStartAt,
    eventEndAt: row.eventEndAt,
    feeAmount: row.feeAmount,
    publishedAt: row.publishedAt,
    organizer: {
      slug: row.institutionSlug,
      name: row.institutionName,
      logoUrl: null,
    },
    ctaState: deriveCTAState(row.registrationStartAt, row.registrationEndAt),
  };
};
