import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-public-service");

import {
  and,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  institutions,
  type CompetitionCategory,
  type CompetitionMode,
} from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { getMeilisearchClient } from "@/server/search/client";
import { isMeilisearchAvailable } from "@/server/search/availability";
import {
  COMPETITION_INDEX_NAME,
  type CompetitionIndexDocument,
} from "@/server/search/competition-index";
import { isCompetitionCategory, isCompetitionMode } from "@/server/competitions/competition-core";
import {
  getInstitutionDisplayName,
  institutionOwnerUsernameSql,
} from "@/server/institution-workspace/institution-display-name";
import type { InstitutionType } from "@/server/db/schema";

// Public listing columns — includes institution display name joined from the institutions table.
// Does not expose fee_amount or fee_currency (DEC-0022). isFeatured is exposed for placement UI.
// institutionName is resolved through getInstitutionDisplayName (mapPublicListingRow): a personal
// institution stores NULL and derives its name from the owner username (institutionOwnerUsername).
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
  isFeatured: competitions.isFeatured,
  institutionSlug: institutions.slug,
  institutionDisplayName: institutions.displayName,
  institutionType: institutions.institutionType,
  institutionOwnerUsername: institutionOwnerUsernameSql,
} as const;

type PublicListingRow = {
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
  isFeatured: boolean;
  institutionSlug: string;
  institutionDisplayName: string | null;
  institutionType: InstitutionType | null;
  institutionOwnerUsername: string | null;
};

// Resolve the joined institution name through the display-name helper, then drop the type/owner
// projection columns so the public shape stays exactly PublicCompetitionItem.
const mapPublicListingRow = (row: PublicListingRow): PublicCompetitionItem => {
  const {
    institutionDisplayName,
    institutionType,
    institutionOwnerUsername,
    ...rest
  } = row;
  return {
    ...rest,
    institutionName: getInstitutionDisplayName(
      { displayName: institutionDisplayName, institutionType },
      { username: institutionOwnerUsername },
    ),
  };
};

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
  isFeatured: boolean;
  institutionSlug: string;
  institutionName: string;
};

export type PublicListingSort = "deadline_asc" | "deadline_desc" | "created_desc";

export type PublicListingFilters = {
  q?: string;
  category?: string;
  mode?: string;
  status?: string;
  teamSize?: string;
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

// Featured-first sort: applies to all sort modes so featured competitions are always
// visually prominent regardless of the secondary sort criterion chosen by the caller.
const FEATURED_SORT_EXPRS = [
  desc(competitions.isFeatured),
  sql`${competitions.featuredOrder} ASC NULLS LAST`,
] as const;

const buildDbOrderBy = (sort: PublicListingSort) => {
  if (sort === "deadline_asc")
    return [...FEATURED_SORT_EXPRS, sql`${competitions.registrationEndAt} ASC NULLS LAST`];
  if (sort === "deadline_desc")
    return [...FEATURED_SORT_EXPRS, desc(competitions.registrationEndAt)];
  return [...FEATURED_SORT_EXPRS, desc(competitions.createdAt)]; // created_desc default
};

// Registration-phase filter. Absent/unknown status returns the default "hide expired" clause
// (F15), so the un-filtered listing is unchanged. Only status="closed" surfaces past-deadline
// competitions. "closing" = under 7 days left, matching the competition card badge window.
const buildStatusCondition = (status: string | undefined): SQL => {
  const start = competitions.registrationStartAt;
  const end = competitions.registrationEndAt;
  if (status === "upcoming") {
    return and(isNotNull(start), gt(start, sql`now()`))!;
  }
  if (status === "open") {
    return and(
      or(isNull(start), lte(start, sql`now()`))!,
      or(isNull(end), gte(end, sql`now() + interval '7 days'`))!,
    )!;
  }
  if (status === "closing") {
    return and(
      or(isNull(start), lte(start, sql`now()`))!,
      isNotNull(end),
      gte(end, sql`now()`),
      lt(end, sql`now() + interval '7 days'`),
    )!;
  }
  if (status === "closed") {
    return and(isNotNull(end), lt(end, sql`now()`))!;
  }
  return or(isNull(end), gte(end, sql`now()`))!;
};

// Team-size bucket filter (DB-only; the Meilisearch index carries no team columns). Range
// overlap, mode-aware: individual-only competitions accept a solo participant; team/both
// competitions carry an allowed [min, max] range.
const buildTeamSizeCondition = (bucket: string | undefined): SQL | undefined => {
  const min = competitions.minTeamSize;
  const max = competitions.maxTeamSize;
  const mode = competitions.mode;
  if (bucket === "solo") {
    return or(eq(mode, "individual"), eq(mode, "both"), and(isNotNull(min), lte(min, 1)));
  }
  if (bucket === "small") {
    return and(
      inArray(mode, ["team", "both"]),
      or(isNull(min), lte(min, 4))!,
      or(isNull(max), gte(max, 2))!,
    )!;
  }
  if (bucket === "large") {
    return and(inArray(mode, ["team", "both"]), or(isNull(max), gte(max, 5))!)!;
  }
  return undefined;
};

// A query with no letters or digits (e.g. only punctuation like ";") carries no searchable
// term. Meilisearch normalizes it to an empty query and runs a placeholder search that returns
// the entire catalog — so such queries must never reach the search path, and must match no
// competition on the DB path.
const hasSearchableQuery = (q: string | undefined): boolean =>
  Boolean(q && /[\p{L}\p{N}]/u.test(q));

// Meili routing (spec §6): the index lacks registrationStartAt and team-size fields, so any
// active status/teamSize filter forces the DB path to avoid partial filtering + count drift.
// A token-less query is also kept off the search path (it would placeholder-match everything).
export const resolveUseSearch = (
  filters: PublicListingFilters,
  meiliAvailable: boolean,
): boolean =>
  hasSearchableQuery(filters.q) && meiliAvailable && !filters.status && !filters.teamSize;

const buildDbWhere = (filters: PublicListingFilters) => {
  const conditions = [
    eq(competitions.status, "published"),
    isNull(competitions.deletedAt),
    buildStatusCondition(filters.status),
  ];

  if (filters.q?.trim()) {
    if (hasSearchableQuery(filters.q)) {
      const term = `%${filters.q.trim()}%`;
      conditions.push(or(ilike(competitions.title, term), ilike(competitions.description, term))!);
    } else {
      // Token-less query (punctuation/symbols only) cannot match any competition.
      conditions.push(sql`false`);
    }
  }
  if (filters.category && isCompetitionCategory(filters.category)) {
    conditions.push(eq(competitions.category, filters.category));
  }
  if (filters.mode && isCompetitionMode(filters.mode)) {
    conditions.push(eq(competitions.mode, filters.mode));
  }
  const teamSizeCondition = buildTeamSizeCondition(filters.teamSize);
  if (teamSizeCondition) {
    conditions.push(teamSizeCondition);
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
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(where);

  const total = countRow?.count ?? 0;

  return {
    data: rows.map(mapPublicListingRow),
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
  // Epoch seconds — deadline field stored as UNIX epoch; unquoted numeric comparison required.
  const epochNow = Math.floor(Date.now() / 1000);
  const filterParts: string[] = [
    'status = "published"',
    // F15: hide competitions whose registration deadline has passed. Null deadline = no deadline.
    `(deadline >= ${epochNow} OR deadline IS NULL)`,
  ];
  if (filters.category && isCompetitionCategory(filters.category)) {
    filterParts.push(`category = "${filters.category}"`);
  }
  if (filters.mode && isCompetitionMode(filters.mode)) {
    filterParts.push(`mode = "${filters.mode}"`);
  }
  if (filters.institutionSlug) {
    filterParts.push(`institutionSlug = "${filters.institutionSlug.trim().toLowerCase()}"`);
  }

  // Build Meilisearch sort expression — featured-first prepended to all sort modes.
  const meiliSecondary =
    sort === "deadline_asc"
      ? "deadline:asc"
      : sort === "deadline_desc"
        ? "deadline:desc"
        : "createdAt:desc";
  const meiliSort = ["isFeatured:desc", "featuredOrder:asc", meiliSecondary];

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
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        searchEngine: "meilisearch",
      },
    };
  }

  // Hydrate from DB — re-apply status = published + deadline guards so Meilisearch results
  // are not trusted as the source of truth. Competitions unpublished or whose deadline
  // passed between indexing and query execution are filtered out here.
  const rows = await db
    .select(PUBLIC_LISTING_COLUMNS)
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitions.status, "published"),
        isNull(competitions.deletedAt),
        inArray(competitions.id, ids),
        or(isNull(competitions.registrationEndAt), gte(competitions.registrationEndAt, sql`now()`))!,
      ),
    );

  // Preserve Meilisearch result order.
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids
    .map((id) => rowById.get(id))
    .filter((r): r is PublicListingRow => Boolean(r))
    .map(mapPublicListingRow);

  return {
    data: ordered,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit), searchEngine: "meilisearch" },
  };
};

export const listPublicCompetitions = async (
  filters: PublicListingFilters,
  db: Database = getDb(),
): Promise<PublicListingResult> => {
  const useSearch = resolveUseSearch(filters, isMeilisearchAvailable());

  if (useSearch) {
    try {
      const meiliResult = await listFromMeilisearch(filters, db);
      // Only trust Meilisearch results when the index actually hydrated rows from the DB.
      // Meili's estimatedTotalHits can be non-zero while DB hydration yields nothing — a stale
      // index (competition re-indexed under a different id, or indexed before a change) reports
      // a phantom count with an empty grid. Check the hydrated data, not the estimate, and fall
      // through to DB ILIKE search when nothing hydrated.
      if (meiliResult.data.length > 0) return meiliResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn("competition-public-listing.meilisearch-fallback", {
        reason: errorMessage,
        q: filters.q,
      });
    }
  } else if (filters.q && !isMeilisearchAvailable()) {
    logger.warn("competition-public-listing.meilisearch-unavailable", {
      reason: "MEILISEARCH_HOST not configured",
      q: filters.q,
    });
  }

  return listFromDb(filters, db);
};

// Featured competitions for the homepage. Same published + not-deleted + live-deadline guards as
// the public listing, restricted to is_featured, ordered by featured_order (NULLS LAST). No paging
// — the homepage renders a small fixed set.
export const listFeaturedCompetitions = async (
  limit = 6,
  db: Database = getDb(),
): Promise<PublicCompetitionItem[]> => {
  const rows = await db
    .select(PUBLIC_LISTING_COLUMNS)
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitions.status, "published"),
        isNull(competitions.deletedAt),
        eq(competitions.isFeatured, true),
        or(isNull(competitions.registrationEndAt), gte(competitions.registrationEndAt, sql`now()`))!,
      ),
    )
    .orderBy(sql`${competitions.featuredOrder} ASC NULLS LAST`, desc(competitions.createdAt))
    .limit(limit);

  return rows.map(mapPublicListingRow);
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
  institutionDisplayName: institutions.displayName,
  institutionType: institutions.institutionType,
  institutionOwnerUsername: institutionOwnerUsernameSql,
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
      name: getInstitutionDisplayName(
        { displayName: row.institutionDisplayName, institutionType: row.institutionType },
        { username: row.institutionOwnerUsername },
      ),
      logoUrl: null,
    },
    ctaState: deriveCTAState(row.registrationStartAt, row.registrationEndAt),
  };
};
