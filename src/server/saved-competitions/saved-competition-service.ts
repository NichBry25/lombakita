import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/saved-competitions/saved-competition-service");

import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  competitionSaves,
  institutions,
  type CompetitionCategory,
  type CompetitionMode,
} from "@/server/db/schema";

// Visibility decision for saved competitions list (Step 3.6):
// - `archived` competitions are silently excluded — they are terminal and the student cannot
//   act on them. Removing them keeps the list clean.
// - `draft` (unpublished) competitions are included but flagged as "unavailable" so the
//   student sees their bookmark is stale and can remove it.

export type SavedCompetitionStatus = "available" | "unavailable";

export type SavedCompetitionItem = {
  competitionId: string;
  slug: string;
  title: string;
  institutionSlug: string;
  institutionName: string;
  category: CompetitionCategory | null;
  mode: CompetitionMode | null;
  registrationEndAt: Date | null;
  savedAt: Date;
  savedStatus: SavedCompetitionStatus;
};

export type SavedCompetitionsResult = {
  data: SavedCompetitionItem[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

const DEFAULT_PAGE_SIZE = 20;

const resolvePage = (raw: number | undefined): number => {
  if (!raw || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
};

const resolveLimit = (raw: number | undefined): number => {
  if (!raw || !Number.isFinite(raw) || raw < 1) return DEFAULT_PAGE_SIZE;
  return raw;
};

const SAVED_COLUMNS = {
  competitionId: competitions.id,
  slug: competitions.slug,
  title: competitions.title,
  category: competitions.category,
  mode: competitions.mode,
  registrationEndAt: competitions.registrationEndAt,
  status: competitions.status,
  institutionSlug: institutions.slug,
  institutionName: institutions.displayName,
  savedAt: competitionSaves.savedAt,
} as const;

export const saveCompetition = async (
  userId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<void> => {
  // Validate competition exists (non-deleted) and is saveable.
  const [comp] = await db
    .select({ id: competitions.id, status: competitions.status })
    .from(competitions)
    .where(and(eq(competitions.id, competitionId), isNull(competitions.deletedAt)));

  if (!comp) {
    throw new SavedCompetitionError("competition_not_found", 404, "Competition not found");
  }

  if (comp.status === "archived") {
    throw new SavedCompetitionError(
      "competition_not_saveable",
      400,
      "Competition is no longer available",
    );
  }

  // Idempotent insert — composite PK conflict is swallowed.
  await db.insert(competitionSaves).values({ userId, competitionId }).onConflictDoNothing();
};

export const unsaveCompetition = async (
  userId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<void> => {
  // Idempotent delete — no error if the row does not exist.
  await db
    .delete(competitionSaves)
    .where(
      and(eq(competitionSaves.userId, userId), eq(competitionSaves.competitionId, competitionId)),
    );
};

export const isSavedCompetition = async (
  userId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [row] = await db
    .select({ competitionId: competitionSaves.competitionId })
    .from(competitionSaves)
    .where(
      and(eq(competitionSaves.userId, userId), eq(competitionSaves.competitionId, competitionId)),
    );

  return Boolean(row);
};

export const listSavedCompetitions = async (
  userId: string,
  opts: { page?: number; limit?: number } = {},
  db: Database = getDb(),
): Promise<SavedCompetitionsResult> => {
  const page = resolvePage(opts.page);
  const limit = resolveLimit(opts.limit);
  const offset = (page - 1) * limit;

  // Exclude archived competitions silently; include draft (unpublished) with flag.
  const where = and(
    eq(competitionSaves.userId, userId),
    isNull(competitions.deletedAt),
    ne(competitions.status, "archived"),
  );

  const rows = await db
    .select(SAVED_COLUMNS)
    .from(competitionSaves)
    .innerJoin(competitions, eq(competitions.id, competitionSaves.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(where)
    .orderBy(desc(competitionSaves.savedAt))
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(competitionSaves)
    .innerJoin(competitions, eq(competitions.id, competitionSaves.competitionId))
    .where(where);

  const total = countRow?.count ?? 0;

  const data: SavedCompetitionItem[] = rows.map((row) => ({
    competitionId: row.competitionId,
    slug: row.slug,
    title: row.title,
    institutionSlug: row.institutionSlug,
    institutionName: row.institutionName,
    category: row.category,
    mode: row.mode,
    registrationEndAt: row.registrationEndAt,
    savedAt: row.savedAt,
    savedStatus: row.status === "published" ? "available" : "unavailable",
  }));

  return {
    data,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
};

export class SavedCompetitionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const toSavedCompetitionErrorResponse = (error: SavedCompetitionError): Response => {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
};
