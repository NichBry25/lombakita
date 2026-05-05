import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  institutionMemberships,
  institutions,
  type CompetitionStatus,
} from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  CompetitionError,
  isAllowedStatusTransition,
  normalizeCompetitionSlug,
  PATCH_FIELDS,
  validatePublishChecklist,
  type CompetitionCreateInput,
  type CompetitionPatchInput,
} from "@/server/competitions/competition-core";
import {
  assertCompetitionAccess,
  assertCompetitionRead,
  assertInstitutionVerified,
  hasActiveRegistrationsForCompetition,
  PUBLIC_COMPETITION_COLUMNS,
  type CompetitionRow,
} from "@/server/competitions/competition-access";

assertServerOnly("server/competitions/competition-service");

const PAGE_SIZE = 20;
const MAX_SLUG_ATTEMPTS = 20;
const FALLBACK_SLUG_BASE = "kompetisi";

const isCompetitionSlugUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== "23505") return false;
  return (
    e.constraint === "competitions_institution_id_slug_unique_idx" ||
    e.constraint_name === "competitions_institution_id_slug_unique_idx"
  );
};

const buildSlugCandidate = (base: string, attempt: number): string => {
  if (attempt === 0) return base;
  const suffix = `-${attempt + 1}`;
  const safeBase =
    base.length > 0 ? base.slice(0, Math.max(3, 64 - suffix.length)) : FALLBACK_SLUG_BASE;
  return `${safeBase.replace(/-+$/g, "")}${suffix}`;
};

const deriveSlugBaseFromTitle = (title: string): string => {
  const normalized = normalizeCompetitionSlug(title);
  return normalized.length >= 3 ? normalized : FALLBACK_SLUG_BASE;
};

// Verifies the actor has an active membership (admin or staff) in the institution
// and resolves the institution row. Used by the create path which receives institutionSlug
// from the request body. Reused mutating helpers for the existing-competition routes use
// assertCompetitionAccess instead.
const requireInstitutionMembershipBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  db: Database,
): Promise<{ institutionId: string }> => {
  const [row] = await db
    .select({ id: institutions.id })
    .from(institutions)
    .innerJoin(
      institutionMemberships,
      and(
        eq(institutionMemberships.institutionId, institutions.id),
        eq(institutionMemberships.userId, actorUserId),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .where(eq(institutions.slug, institutionSlug))
    .limit(1);

  if (!row) {
    throw new AccessError("forbidden", 403, "Institution member access required");
  }
  return { institutionId: row.id };
};

export const createCompetitionDraft = async (
  actorUserId: string,
  input: CompetitionCreateInput,
  db: Database = getDb(),
): Promise<CompetitionRow> => {
  const { institutionId } = await requireInstitutionMembershipBySlug(
    actorUserId,
    input.institutionSlug,
    db,
  );

  const baseSlug = input.slug ?? deriveSlugBaseFromTitle(input.title);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = buildSlugCandidate(baseSlug, attempt);
    try {
      const [row] = await db
        .insert(competitions)
        .values({
          institutionId,
          createdByUserId: actorUserId,
          slug: candidate,
          title: input.title,
          description: input.description,
          status: "draft",
        })
        .returning(PUBLIC_COMPETITION_COLUMNS);
      if (!row) {
        throw new Error("Failed to create competition draft");
      }
      return row;
    } catch (error) {
      if (isCompetitionSlugUniqueViolation(error)) {
        // If the user supplied an explicit slug, surface the conflict instead of auto-suffixing.
        if (input.slug) {
          throw new CompetitionError(
            "competition_slug_taken",
            409,
            "slug is already used by another competition in this institution",
            { fields: ["slug"] },
          );
        }
        continue;
      }
      throw error;
    }
  }

  throw new CompetitionError(
    "competition_slug_taken",
    409,
    "Could not allocate a unique competition slug — please supply one manually",
    { fields: ["slug"] },
  );
};

export type CompetitionListFilters = {
  institutionSlug: string;
  status?: CompetitionStatus;
  page?: number;
};

export const listCompetitionsForMember = async (
  actorUserId: string,
  filters: CompetitionListFilters,
  db: Database = getDb(),
): Promise<{ competitions: CompetitionRow[]; total: number; page: number }> => {
  const { institutionId } = await requireInstitutionMembershipBySlug(
    actorUserId,
    filters.institutionSlug,
    db,
  );

  const page = Math.max(1, filters.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const where = filters.status
    ? and(
        eq(competitions.institutionId, institutionId),
        isNull(competitions.deletedAt),
        eq(competitions.status, filters.status),
      )
    : and(eq(competitions.institutionId, institutionId), isNull(competitions.deletedAt));

  const rows = await db
    .select(PUBLIC_COMPETITION_COLUMNS)
    .from(competitions)
    .where(where)
    .orderBy(desc(competitions.createdAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(competitions)
    .where(where);

  return { competitions: rows, total: countRow?.count ?? 0, page };
};

export const getCompetitionForReader = async (
  actorUserId: string,
  actorRole: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<CompetitionRow> => {
  const { competition } = await assertCompetitionRead(actorUserId, actorRole, competitionId, db);
  return competition;
};

export const updateCompetitionDraft = async (
  actorUserId: string,
  competitionId: string,
  patch: CompetitionPatchInput,
  db: Database = getDb(),
): Promise<CompetitionRow> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);

  // Field-lock: published competitions cannot be edited via PATCH. Archived as well — they're terminal.
  if (competition.status !== "draft") {
    const lockedFields = Object.keys(patch).filter((k) => PATCH_FIELDS.includes(k));
    throw new CompetitionError(
      "competition_field_locked",
      409,
      `Cannot edit fields on a ${competition.status} competition. Transition to draft first via PATCH /status.`,
      { fields: lockedFields },
    );
  }

  const updates: Record<string, unknown> = { updatedAt: sql`now()` };
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.slug !== undefined) updates.slug = patch.slug;
  if (patch.category !== undefined) updates.category = patch.category;
  if (patch.mode !== undefined) updates.mode = patch.mode;
  if (patch.minTeamSize !== undefined) updates.minTeamSize = patch.minTeamSize;
  if (patch.maxTeamSize !== undefined) updates.maxTeamSize = patch.maxTeamSize;
  if (patch.registrationStartAt !== undefined)
    updates.registrationStartAt = patch.registrationStartAt;
  if (patch.registrationEndAt !== undefined) updates.registrationEndAt = patch.registrationEndAt;
  if (patch.eventStartAt !== undefined) updates.eventStartAt = patch.eventStartAt;
  if (patch.eventEndAt !== undefined) updates.eventEndAt = patch.eventEndAt;

  // Nothing besides the timestamp — no-op fast path.
  if (Object.keys(updates).length === 1) {
    return competition;
  }

  try {
    const [row] = await db
      .update(competitions)
      .set(updates)
      .where(eq(competitions.id, competitionId))
      .returning(PUBLIC_COMPETITION_COLUMNS);
    if (!row) {
      throw new CompetitionError("competition_not_found", 404, "Competition not found");
    }
    return row;
  } catch (error) {
    if (isCompetitionSlugUniqueViolation(error)) {
      throw new CompetitionError(
        "competition_slug_taken",
        409,
        "slug is already used by another competition in this institution",
        { fields: ["slug"] },
      );
    }
    throw error;
  }
};

// Soft-delete a draft. Published and archived records are not deletable via DELETE —
// published must transition to archived via PATCH /status; archived records are terminal.
export const softDeleteCompetitionDraft = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<void> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);

  if (competition.status !== "draft") {
    throw new CompetitionError(
      "competition_delete_not_allowed",
      409,
      `Only draft competitions can be deleted. Current status: ${competition.status}.`,
    );
  }

  await db
    .update(competitions)
    .set({ deletedAt: new Date(), updatedAt: sql`now()` })
    .where(eq(competitions.id, competitionId));
};

export type StatusTransitionResult = { competition: CompetitionRow };

export const transitionCompetitionStatus = async (
  actorUserId: string,
  competitionId: string,
  targetStatus: CompetitionStatus,
  db: Database = getDb(),
): Promise<StatusTransitionResult> => {
  // All transitions require institution_admin.
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "admin", db);

  // Same-status transitions are rejected as invalid: ALLOWED_TRANSITIONS does not contain any
  // from===to edge. State-machines.md §8.1 requires 422 for this case (e.g. archived → archived).
  if (!isAllowedStatusTransition(competition.status, targetStatus)) {
    throw new CompetitionError(
      "competition_invalid_transition",
      422,
      `Cannot transition competition from '${competition.status}' to '${targetStatus}'`,
    );
  }

  // Publish guards: institution must be verified, publish-validation checklist must pass.
  if (competition.status === "draft" && targetStatus === "published") {
    await assertInstitutionVerified(competition.institutionId, db);
    const missing = validatePublishChecklist({
      title: competition.title,
      description: competition.description,
      mode: competition.mode,
      registrationStartAt: competition.registrationStartAt,
      registrationEndAt: competition.registrationEndAt,
      eventStartAt: competition.eventStartAt,
      eventEndAt: competition.eventEndAt,
    });
    if (missing.length > 0) {
      throw new CompetitionError(
        "competition_publish_validation_failed",
        422,
        `Cannot publish: missing required fields: ${missing.join(", ")}`,
        { fields: missing },
      );
    }
  }

  // Unpublish guard: stub returns false until Phase 4 registration logic exists.
  if (competition.status === "published" && targetStatus === "draft") {
    const blocked = await hasActiveRegistrationsForCompetition(competitionId, db);
    if (blocked) {
      throw new CompetitionError(
        "competition_active_registrations",
        409,
        "Cannot unpublish: this competition has active registrations",
      );
    }
  }

  const updates: Record<string, unknown> = {
    status: targetStatus,
    updatedAt: sql`now()`,
  };
  if (targetStatus === "published") updates.publishedAt = new Date();
  if (targetStatus === "archived") updates.archivedAt = new Date();

  const [row] = await db
    .update(competitions)
    .set(updates)
    .where(eq(competitions.id, competitionId))
    .returning(PUBLIC_COMPETITION_COLUMNS);

  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }

  logger.info("competition.status.transitioned", {
    competitionId,
    actorUserId,
    from: competition.status,
    to: targetStatus,
  });

  return { competition: row };
};
