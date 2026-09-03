import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-public-service");

import {
  and,
  asc,
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
  competitionPrizes,
  competitionRegistrations,
  competitionResults,
  competitionRounds,
  competitionTags,
  institutionSocialLinks,
  institutions,
  type CompetitionCategory,
  type CompetitionMode,
} from "@/server/db/schema";
import { isR2Available, generatePresignedGetUrl } from "@/server/storage/r2.client";
import { logger } from "@/lib/logger";
import { getMeilisearchClient } from "@/server/search/client";
import { isMeilisearchAvailable } from "@/server/search/availability";
import {
  COMPETITION_INDEX_NAME,
  type CompetitionIndexDocument,
} from "@/server/search/competition-index";
import { isCompetitionCategory, isCompetitionMode } from "@/server/competitions/competition-core";
import {
  deriveCompetitionPhase,
  type CompetitionPhase,
} from "@/lib/competitions/competition-phase";
import {
  getInstitutionDisplayName,
  institutionOwnerUsernameSql,
} from "@/server/institution-workspace/institution-display-name";
import {
  institutionOwnerAvatarKeySql,
  institutionOwnerBannerKeySql,
  resolveInstitutionMediaKeys,
} from "@/server/institution-workspace/institution-media";
import type { InstitutionType } from "@/server/db/schema";
import {
  deriveCompetitionParticipationState,
  type CompetitionParticipationState,
} from "@/lib/competitions/competition-participation";
import { countCompetitionParticipantEntries } from "@/server/competitions/competition-participation-service";

// Whether the competition has any published result. A correlated EXISTS rather than a join, so a
// listing page costs one extra scalar per row instead of a second query per competition. Follows
// the institutionOwnerUsernameSql form: the outer reference must be the literal `competitions.id`.
const competitionHasPublishedResultSql = sql<boolean>`exists (
  select 1 from ${competitionResults}
  where ${competitionResults.competitionId} = competitions.id
    and ${competitionResults.resultStatus} = 'published'
)`;

// Public listing columns — includes institution display name joined from the institutions table.
// The LISTING exposes neither fee_amount nor fee_currency (DEC-0022); the DETAIL projection below
// exposes BOTH, together. isFeatured is exposed for placement UI.
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
  resultAnnouncementAt: competitions.resultAnnouncementAt,
  cancelledAt: competitions.cancelledAt,
  hasPublishedResult: competitionHasPublishedResultSql,
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
  resultAnnouncementAt: Date | null;
  cancelledAt: Date | null;
  hasPublishedResult: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  isFeatured: boolean;
  institutionSlug: string;
  institutionDisplayName: string | null;
  institutionType: InstitutionType;
  institutionOwnerUsername: string | null;
};

// Resolve the joined institution name through the display-name helper, then drop the type/owner
// projection columns so the public shape stays exactly PublicCompetitionItem.
const mapPublicListingRow = (row: PublicListingRow): PublicCompetitionItem => {
  const { institutionDisplayName, institutionType, institutionOwnerUsername, ...rest } = row;
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
  resultAnnouncementAt: Date | null;
  cancelledAt: Date | null;
  hasPublishedResult: boolean;
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

// No listing this product will ever serve has enough rows to fill this many pages even at the
// smallest page size — at MAX_PAGE_SIZE that is 5,000,000 rows. It exists purely to keep `offset`
// (below) inside what both engines behind this function can accept: an unclamped page number
// reached Postgres as an OFFSET past bigint range and Postgres answered with a 500 instead of an
// empty page. `Number.isFinite` does not catch this — a huge but finite value like 1e20 survives
// it and only loses precision, it does not become non-finite.
const MAX_PAGE = 100_000;

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
  return Math.min(Math.floor(raw), MAX_PAGE);
};

// What it means for a competition to be publicly visible, stated once. Every public read — the
// listing, its count, Meilisearch hydration, the featured rail, and the detail page — applies
// exactly these conditions, so they are defined here rather than repeated five times where one
// copy could silently drift from the others.
//
// The institution clause is the reason this exists: a suspended institution has no public
// footprint. Its own page is already withheld, and its competitions are withheld with it.
// Suspension is the operational takedown axis, distinct from unpublishing (which the organizer
// controls and which cancels every registration) — withholding here changes public visibility
// only and leaves competition status, registrations, and results untouched.
//
// Callers must join `institutions`; all five already do. Meilisearch carries no suspension field,
// so the search path enforces this at DB hydration, the same way it re-checks published status
// rather than trusting the index.
export const buildPublicVisibilityCondition = (): SQL =>
  and(
    eq(competitions.status, "published"),
    isNull(competitions.deletedAt),
    isNull(institutions.suspendedAt),
  )!;

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

// Registration-phase filter. Absent/unknown status returns the default "hide expired" clause,
// so the un-filtered listing is unchanged. Only status="closed" surfaces past-deadline
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
  // "all" spans every registration phase, including finished competitions. The organizer's own
  // public page uses it: a finished competition is the record participants come back to.
  if (status === "all") {
    return sql`true`;
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
export const resolveUseSearch = (filters: PublicListingFilters, meiliAvailable: boolean): boolean =>
  hasSearchableQuery(filters.q) && meiliAvailable && !filters.status && !filters.teamSize;

const buildDbWhere = (filters: PublicListingFilters) => {
  const conditions = [buildPublicVisibilityCondition(), buildStatusCondition(filters.status)];

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
    // Hide competitions whose registration deadline has passed. Null deadline = no deadline.
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

  // Hydrate from DB — re-apply status = published + deadline + institution-suspension guards so
  // Meilisearch results are not trusted as the source of truth. Competitions unpublished, whose
  // deadline passed, or whose organizer was suspended between indexing and query execution are
  // filtered out here.
  const rows = await db
    .select(PUBLIC_LISTING_COLUMNS)
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        buildPublicVisibilityCondition(),
        inArray(competitions.id, ids),
        or(
          isNull(competitions.registrationEndAt),
          gte(competitions.registrationEndAt, sql`now()`),
        )!,
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
        buildPublicVisibilityCondition(),
        eq(competitions.isFeatured, true),
        or(
          isNull(competitions.registrationEndAt),
          gte(competitions.registrationEndAt, sql`now()`),
        )!,
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
  cancelledAt: Date | null = null,
): RegistrationCTAState => {
  if (cancelledAt) return "closed";
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
  resultAnnouncementAt: competitions.resultAnnouncementAt,
  minimumParticipantEntries: competitions.minimumParticipantEntries,
  participantConfirmationAt: competitions.participantConfirmationAt,
  participationConfirmedAt: competitions.participationConfirmedAt,
  cancelledAt: competitions.cancelledAt,
  cancellationReason: competitions.cancellationReason,
  feeAmount: competitions.feeAmount,
  feeCurrency: competitions.feeCurrency,
  eligibilityNote: competitions.eligibilityNote,
  publishedAt: competitions.publishedAt,
  institutionId: institutions.id,
  institutionSlug: institutions.slug,
  institutionDisplayName: institutions.displayName,
  institutionType: institutions.institutionType,
  institutionOwnerUsername: institutionOwnerUsernameSql,
  institutionLogoR2Key: institutions.logoR2Key,
  institutionBannerR2Key: institutions.bannerR2Key,
  // A personal institution shows its owner's profile imagery in place of the logo and banner it
  // cannot upload.
  institutionOwnerAvatarKey: institutionOwnerAvatarKeySql,
  institutionOwnerBannerKey: institutionOwnerBannerKeySql,
  institutionAbout: institutions.about,
  institutionContactName: institutions.contactName,
  institutionContactEmail: institutions.contactEmail,
  institutionContactPhone: institutions.contactPhone,
  institutionWebsiteUrl: institutions.websiteUrl,
} as const;

const LOGO_GET_URL_EXPIRY_SECONDS = 3600;

// Sign a fresh GET URL for the organizer logo at render time (private R2 object). Returns null when
// no logo is stored, storage is unconfigured, or signing fails — the UI falls back to a placeholder.
const resolveOrganizerLogoUrl = async (logoR2Key: string | null): Promise<string | null> => {
  if (!logoR2Key || !isR2Available()) return null;
  try {
    return await generatePresignedGetUrl(logoR2Key, LOGO_GET_URL_EXPIRY_SECONDS);
  } catch {
    return null;
  }
};

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
  // The date the organizer committed to announcing results, if they set one.
  resultAnnouncementAt: Date | null;
  minimumParticipantEntries: number | null;
  participantConfirmationAt: Date | null;
  participationConfirmedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  participantEntryCount: number;
  participationState: CompetitionParticipationState;
  feeAmount: number | null;
  feeCurrency: string | null;
  eligibilityNote: string | null;
  tags: string[];
  publishedAt: Date | null;
  registrantCount: number;
  prizes: Array<{
    rankLabel: string | null;
    title: string;
    description: string | null;
    cashAmount: string | null;
    isCertificate: boolean;
  }>;
  // Sum of prize cash amounts (display only). Null when no prize carries a cash amount.
  prizePoolTotal: number | null;
  rounds: Array<{
    title: string;
    description: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
    platformLabel: string | null;
  }>;
  organizer: {
    slug: string;
    name: string;
    logoUrl: string | null;
    about: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    websiteUrl: string | null;
    socialLinks: Array<{ platform: string; url: string }>;
  };
  ctaState: RegistrationCTAState;
  // Where the competition is in its lifecycle, derived at read time from the dates above and
  // whether results have been published. Display only — it authorizes nothing.
  phase: CompetitionPhase;
};

// Count of confirmed registration rows for the public "terdaftar" figure. Team submission writes
// one row per member, so this remains the physical-person count shown by the existing UI. Minimum
// participation uses countCompetitionParticipantEntries instead, where one team is one entry.
export const countPublicRegistrants = async (
  competitionId: string,
  db: Database = getDb(),
): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        eq(competitionRegistrations.status, "confirmed"),
      ),
    );
  return row?.count ?? 0;
};

// Whether any result for this competition has been published. Only the existence of a published
// result is read — never its contents, which stay candidate-scoped — because all the public phase
// needs to know is whether the organizer has announced anything yet.
export const hasPublishedCompetitionResult = async (
  competitionId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [row] = await db
    .select({ id: competitionResults.id })
    .from(competitionResults)
    .where(
      and(
        eq(competitionResults.competitionId, competitionId),
        eq(competitionResults.resultStatus, "published"),
      ),
    )
    .limit(1);
  return row !== undefined;
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
        buildPublicVisibilityCondition(),
        eq(competitions.slug, competitionSlug),
        eq(institutions.slug, institutionSlug),
      ),
    );

  if (!row) return null;

  const { logoKey } = resolveInstitutionMediaKeys(
    {
      institutionType: row.institutionType,
      logoR2Key: row.institutionLogoR2Key,
      bannerR2Key: row.institutionBannerR2Key,
    },
    {
      avatarR2Key: row.institutionOwnerAvatarKey,
      bannerR2Key: row.institutionOwnerBannerKey,
    },
  );

  const [
    registrantCount,
    participantEntryCount,
    hasPublishedResult,
    logoUrl,
    socialLinks,
    prizes,
    rounds,
    tagRows,
  ] = await Promise.all([
    countPublicRegistrants(row.id, db),
    countCompetitionParticipantEntries(row.id, db),
    hasPublishedCompetitionResult(row.id, db),
    resolveOrganizerLogoUrl(logoKey),
    db
      .select({ platform: institutionSocialLinks.platform, url: institutionSocialLinks.url })
      .from(institutionSocialLinks)
      .where(eq(institutionSocialLinks.institutionId, row.institutionId)),
    db
      .select({
        rankLabel: competitionPrizes.rankLabel,
        title: competitionPrizes.title,
        description: competitionPrizes.description,
        cashAmount: competitionPrizes.cashAmount,
        isCertificate: competitionPrizes.isCertificate,
      })
      .from(competitionPrizes)
      .where(eq(competitionPrizes.competitionId, row.id))
      .orderBy(asc(competitionPrizes.sortOrder)),
    db
      .select({
        title: competitionRounds.title,
        description: competitionRounds.description,
        startsAt: competitionRounds.startsAt,
        endsAt: competitionRounds.endsAt,
        platformLabel: competitionRounds.platformLabel,
      })
      .from(competitionRounds)
      .where(eq(competitionRounds.competitionId, row.id))
      .orderBy(asc(competitionRounds.sortOrder)),
    db
      .select({ tag: competitionTags.tag })
      .from(competitionTags)
      .where(eq(competitionTags.competitionId, row.id))
      .orderBy(asc(competitionTags.tag)),
  ]);
  const tags = tagRows.map((r) => r.tag);

  const prizePoolSum = prizes.reduce(
    (sum, prize) => sum + (prize.cashAmount ? parseFloat(prize.cashAmount) : 0),
    0,
  );
  const prizePoolTotal = prizePoolSum > 0 ? prizePoolSum : null;

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
    resultAnnouncementAt: row.resultAnnouncementAt,
    minimumParticipantEntries: row.minimumParticipantEntries,
    participantConfirmationAt: row.participantConfirmationAt,
    participationConfirmedAt: row.participationConfirmedAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    feeAmount: row.feeAmount,
    feeCurrency: row.feeCurrency,
    eligibilityNote: row.eligibilityNote,
    tags,
    publishedAt: row.publishedAt,
    registrantCount,
    participantEntryCount,
    participationState: deriveCompetitionParticipationState({
      minimumParticipantEntries: row.minimumParticipantEntries,
      participantConfirmationAt: row.participantConfirmationAt,
      participationConfirmedAt: row.participationConfirmedAt,
      eventStartAt: row.eventStartAt,
      cancelledAt: row.cancelledAt,
      participantEntryCount,
    }),
    prizes,
    prizePoolTotal,
    rounds,
    organizer: {
      slug: row.institutionSlug,
      name: getInstitutionDisplayName(
        { displayName: row.institutionDisplayName, institutionType: row.institutionType },
        { username: row.institutionOwnerUsername },
      ),
      logoUrl,
      about: row.institutionAbout,
      contactName: row.institutionContactName,
      contactEmail: row.institutionContactEmail,
      contactPhone: row.institutionContactPhone,
      websiteUrl: row.institutionWebsiteUrl,
      socialLinks,
    },
    ctaState: deriveCTAState(
      row.registrationStartAt,
      row.registrationEndAt,
      new Date(),
      row.cancelledAt,
    ),
    phase: deriveCompetitionPhase({
      cancelledAt: row.cancelledAt,
      registrationStartAt: row.registrationStartAt,
      registrationEndAt: row.registrationEndAt,
      eventStartAt: row.eventStartAt,
      eventEndAt: row.eventEndAt,
      resultAnnouncementAt: row.resultAnnouncementAt,
      hasPublishedResult,
    }),
  };
};
