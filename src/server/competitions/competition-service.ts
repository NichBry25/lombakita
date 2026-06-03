import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { enqueueCompetitionSearchSync } from "@/server/async/enqueue";
import {
  CompetitionError,
  IMMUTABLE_AFTER_PUBLISH,
  isAllowedStatusTransition,
  MAX_SLUG_LENGTH,
  normalizeCompetitionSlug,
  PATCH_FIELDS,
  resolveTeamSizesForMode,
  TEAM_MODE_MIN_SIZE,
  validatePublishChecklist,
  type CompetitionCreateInput,
  type CompetitionPatchInput,
} from "@/server/competitions/competition-core";
import {
  assertCompetitionAccess,
  assertCompetitionRead,
  assertInstitutionVerified,
  assertInstitutionNotSuspended,
  hasActiveRegistrationsForCompetition,
  MEMBER_ROLES,
  PUBLIC_COMPETITION_COLUMNS,
  type CompetitionRow,
} from "@/server/competitions/competition-access";

assertServerOnly("server/competitions/competition-service");

const PAGE_SIZE = 20;
const MAX_SLUG_ATTEMPTS = 20;
const FALLBACK_SLUG_BASE = "kompetisi";

const isCompetitionSlugUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    detail?: string;
  };
  if (e.code !== "23505") return false;
  if (
    e.constraint === "competitions_institution_id_slug_unique_idx" ||
    e.constraint_name === "competitions_institution_id_slug_unique_idx"
  ) {
    return true;
  }
  // postgres-js does not always populate `constraint` / `constraint_name` for unique-index
  // violations (vs unique-constraint violations). Fall back to scanning the detail message,
  // which for a (institution_id, slug) unique-index breach reads:
  //   "Key (institution_id, slug)=(...) already exists."
  const detail = e.detail?.toLowerCase() ?? "";
  return detail.includes("(institution_id, slug)") || detail.includes("(slug)");
};

const buildSlugCandidate = (base: string, attempt: number): string => {
  if (attempt === 0) return base;
  const suffix = `-${attempt + 1}`;
  const safeBase =
    base.length > 0
      ? base.slice(0, Math.max(3, MAX_SLUG_LENGTH - suffix.length))
      : FALLBACK_SLUG_BASE;
  return `${safeBase.replace(/-+$/g, "")}${suffix}`;
};

const deriveSlugBaseFromTitle = (title: string): string => {
  const normalized = normalizeCompetitionSlug(title);
  return normalized.length >= 3 ? normalized : FALLBACK_SLUG_BASE;
};

// Resolves an institution by slug, then verifies that the given competition belongs to it.
// Used by the institution-scoped publish/unpublish/archive routes to defend against URL
// tampering (e.g. caller forges /institutions/A/competitions/B-owned-id/publish). On any
// mismatch — institution slug unknown, competition missing/soft-deleted, or competition owned
// by a different institution — returns 404 to avoid leaking cross-tenant existence.
//
// This helper does NOT enforce actor membership or role. The caller must still invoke
// transitionCompetitionStatus (which runs assertCompetitionAccess admin) to authorize.
export const assertCompetitionInInstitution = async (
  institutionSlug: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<void> => {
  const [row] = await db
    .select({ institutionId: competitions.institutionId })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitions.id, competitionId),
        isNull(competitions.deletedAt),
        eq(institutions.slug, institutionSlug),
      ),
    )
    .limit(1);
  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }
};

// Resolves a competition by institution slug + competition slug (both scoped together).
// This is the page-level slug lookup for G6 institution-side routes. Institution-scoped:
// the same competition slug under two different institutions resolves independently with no
// cross-tenant leak. Returns the competitionId for downstream service calls, or throws 404.
export const getCompetitionIdByInstitutionAndSlug = async (
  institutionSlug: string,
  competitionSlug: string,
  db: Database = getDb(),
): Promise<string> => {
  const [row] = await db
    .select({ id: competitions.id })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(institutions.slug, institutionSlug),
        eq(competitions.slug, competitionSlug),
        isNull(competitions.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }

  return row.id;
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
        inArray(institutionMemberships.membershipRole, MEMBER_ROLES), // institution_member excluded per CCR-09 / DEC-0043
      ),
    )
    .where(eq(institutions.slug, institutionSlug))
    .limit(1);

  if (!row) {
    throw new AccessError("forbidden", 403, "Institution owner/staff access required");
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

  // Step 6.2 — a suspended institution cannot author new competition drafts.
  await assertInstitutionNotSuspended(institutionId, db);

  const baseSlug = input.slug ?? deriveSlugBaseFromTitle(input.title);

  // F5/F14 (Step 6.5b) — mode defaults to individual when unspecified; team sizes are then
  // normalized to that mode so a freshly created draft never persists null/inconsistent sizes
  // (e.g. an individual competition must store 1/1, not null/null).
  const effectiveMode = input.mode ?? "individual";
  const { minTeamSize, maxTeamSize } = resolveTeamSizesForMode(
    effectiveMode,
    input.minTeamSize ?? null,
    input.maxTeamSize ?? null,
  );

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
          category: input.category ?? null,
          mode: effectiveMode,
          minTeamSize,
          maxTeamSize,
          registrationStartAt: input.registrationStartAt ?? null,
          registrationEndAt: input.registrationEndAt ?? null,
          eventStartAt: input.eventStartAt ?? null,
          eventEndAt: input.eventEndAt ?? null,
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

  // Draft-only mutation guard: published and archived competitions cannot be edited via PATCH.
  // Per Step 3.2 contract, this surfaces 409 with code `competition_not_draft`.
  if (competition.status !== "draft") {
    // Defensive secondary check for fields that are permanently immutable after publish.
    // These fields (mode, minTeamSize, maxTeamSize) are locked to the values that participants
    // registered under and must never change, even after unpublish. Fire 422 (not 409) so
    // callers can distinguish "use unpublish first" from "this field can never change".
    const row = competition as unknown as Record<string, unknown>;
    const patchRecord = patch as Record<string, unknown>;
    const immutableChanged = IMMUTABLE_AFTER_PUBLISH.filter(
      (field) => field in patchRecord && patchRecord[field] !== row[field],
    );
    if (immutableChanged.length > 0) {
      throw new CompetitionError(
        "competition_field_immutable",
        422,
        `Cannot modify immutable field(s) on a ${competition.status} competition: ${immutableChanged.join(", ")}`,
        { fields: immutableChanged },
      );
    }

    const lockedFields = Object.keys(patch).filter((k) => PATCH_FIELDS.includes(k));
    throw new CompetitionError(
      "competition_not_draft",
      409,
      `Cannot edit fields on a ${competition.status} competition. Transition to draft first via POST /unpublish.`,
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

  // F5 — normalize team sizes to the effective mode whenever the patch touches mode or a size
  // field. Resolve effective mode/sizes from the patch where present, falling back to the
  // existing row. This catches cross-field cases parse-time validation cannot see (e.g. patching
  // only minTeamSize while the row already has mode=team) and keeps individual/both fixed values
  // consistent. An explicit sub-floor team min is rejected here rather than silently raised.
  const effectiveMode = patch.mode !== undefined ? patch.mode : competition.mode;
  const patchTouchesSizeOrMode =
    patch.mode !== undefined ||
    patch.minTeamSize !== undefined ||
    patch.maxTeamSize !== undefined;
  if (effectiveMode && patchTouchesSizeOrMode) {
    const effectiveMin =
      patch.minTeamSize !== undefined ? patch.minTeamSize : competition.minTeamSize;
    const effectiveMax =
      patch.maxTeamSize !== undefined ? patch.maxTeamSize : competition.maxTeamSize;
    if (effectiveMode === "team" && effectiveMin !== null && effectiveMin < TEAM_MODE_MIN_SIZE) {
      throw new CompetitionError(
        "competition_invalid_value",
        400,
        `team mode requires minTeamSize >= ${TEAM_MODE_MIN_SIZE}`,
        { fields: ["minTeamSize"] },
      );
    }
    const resolved = resolveTeamSizesForMode(effectiveMode, effectiveMin, effectiveMax);
    updates.minTeamSize = resolved.minTeamSize;
    updates.maxTeamSize = resolved.maxTeamSize;
  }

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
// published must transition to archived via POST /archive; archived records are terminal.
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
  // All transitions require institution_owner.
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
  // Validation runs against the merged DB row (not caller payload) so partial PATCHes that left
  // the row internally inconsistent are caught here. This is the second gate referenced in
  // DEC-0028 and addresses the latent material finding D5 from the Step 3.2 depth review.
  if (competition.status === "draft" && targetStatus === "published") {
    await assertInstitutionVerified(competition.institutionId, db);
    // Step 6.2 — both guards must pass: verified AND not suspended.
    await assertInstitutionNotSuspended(competition.institutionId, db);
    const result = validatePublishChecklist({
      title: competition.title,
      description: competition.description,
      category: competition.category,
      mode: competition.mode,
      minTeamSize: competition.minTeamSize,
      maxTeamSize: competition.maxTeamSize,
      registrationStartAt: competition.registrationStartAt,
      registrationEndAt: competition.registrationEndAt,
      eventStartAt: competition.eventStartAt,
      eventEndAt: competition.eventEndAt,
    });
    if (!result.passed) {
      throw new CompetitionError(
        "competition_publish_validation_failed",
        422,
        `Cannot publish: ${result.failures.length} validation issue(s) — see details.failures`,
        {
          fields: result.failures.map((f) => f.field),
          failures: result.failures,
        },
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
  // publishedAt is intentionally NOT cleared on unpublish (published → draft). It records the
  // first-publication timestamp as historical metadata — useful for audit and discovery signals.
  // DEC-0030: accepted design decision.
  if (targetStatus === "archived") updates.archivedAt = new Date();

  // CAS guard: WHERE also checks current status equals the snapshot status to prevent
  // concurrent transitions from landing on top of each other (3.3-D12 resolution).
  const [row] = await db
    .update(competitions)
    .set(updates)
    .where(and(eq(competitions.id, competitionId), eq(competitions.status, competition.status)))
    .returning(PUBLIC_COMPETITION_COLUMNS);

  if (!row) {
    throw new CompetitionError(
      "competition_invalid_transition",
      422,
      "Competition status was modified concurrently — reload and retry the transition",
    );
  }

  logger.info("competition.status.transitioned", {
    competitionId,
    actorUserId,
    from: competition.status,
    to: targetStatus,
  });

  // Enqueue search index sync. publish → upsert; unpublish/archive → remove.
  // The enqueue is fire-and-forget: a failure to enqueue (e.g. Redis unavailable) must not
  // fail the transition itself. The sync job handles its own retry via BullMQ backoff.
  const syncAction = targetStatus === "published" ? "upsert" : "remove";
  enqueueCompetitionSearchSync({ competitionId, action: syncAction }).catch((err) => {
    logger.warn("competition.search-sync.enqueue-failed", {
      competitionId,
      action: syncAction,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { competition: row };
};
