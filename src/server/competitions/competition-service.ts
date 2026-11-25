import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  competitionRegistrations,
  institutionMemberships,
  institutions,
  type CompetitionStatus,
} from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  enqueueCompetitionCancelled,
  enqueueCompetitionEdited,
  enqueueCompetitionSearchSync,
} from "@/server/async/enqueue";
import {
  CompetitionError,
  findMissingPublishFields,
  IMMUTABLE_AFTER_PUBLISH,
  isAllowedStatusTransition,
  MAX_SLUG_LENGTH,
  normalizeCompetitionSlug,
  PATCH_FIELDS,
  PUBLIC_FIELDS_HELD_AFTER_TRUST_REMOVAL,
  resolveTeamSizesForMode,
  TEAM_MODE_MIN_SIZE,
  assertCompetitionTimelineChronological,
  validateCancellationPolicy,
  validateMinimumParticipation,
  validateRegistrationEndInFuture,
  validatePublishChecklist,
  type CompetitionCreateInput,
  type CompetitionPatchInput,
} from "@/server/competitions/competition-core";
import {
  classifyCompetitionEdit,
  type ClassifiableCompetition,
  type EditClassificationSnapshot,
} from "@/server/competitions/edit-classification";
import { INSTITUTION_CANCELLATION_REASON } from "@/server/competitions/competition-lifecycle";
import { hasCompetitionStarted } from "@/lib/competitions/competition-withdrawal";
import { isParticipantCancellationClosedByConfirmation } from "@/lib/competitions/competition-participation";
import { acquireCompetitionParticipationLock } from "@/server/competitions/competition-participation-lock";
import { moveOpenTeamInvitationsToClose } from "@/server/teams/team-invitation-expiry";
import { disbandEveryTeamOfCompetition } from "@/server/teams/team-service";
import { markCompetitionRegistrationsPublicationClosed } from "@/server/registrations/registration-service";
import {
  assertPublishTrustSatisfied,
  assertCompetitionAccess,
  assertCompetitionHasAudience,
  assertCompetitionHasOrganizerContact,
  assertCompetitionRead,
  assertInstitutionNotSuspended,
  assertInstitutionVerified,
  assertPublicFieldsUnchangedByRemovedHost,
  assertWithdrawalNotByRemovedHost,
  assertPersonalCompetitionPublishable,
  assertPersonalInstitutionIndividualMode,
  hasActiveRegistrationsForCompetition,
  MEMBER_ROLES,
  PUBLIC_COMPETITION_COLUMNS,
  type CompetitionRow,
} from "@/server/competitions/competition-access";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import {
  CLOSE_WAITS_FOR_TRANSFER_REVIEW_REASON,
  COMPETITION_CHANGED_DURING_EDIT_REASON,
} from "@/lib/competitions/publish-locks";
import {
  hasActiveFreeRegistrations,
  hasCompetitionPaymentInFlight,
  hasCompetitionTransferAwaitingReview,
} from "@/server/finance/paid-registration";

assertServerOnly("server/competitions/competition-service");

type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

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
// This helper does NOT enforce actor membership or role. The caller must still authorize through
// assertCompetitionAccess at the level its action needs: member to publish and to unpublish.
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
// This is the page-level slug lookup for institution-side routes. Institution-scoped:
// the same competition slug under two different institutions resolves independently with no
// cross-tenant leak. Returns the competitionId for downstream service calls, or throws 404.
// Resolves the competition's id and title from the institution-scoped slug pair. Pages that put
// the competition's name in their heading need both, and getting them together avoids a second
// round trip for one column.
export const getCompetitionIdentityByInstitutionAndSlug = async (
  institutionSlug: string,
  competitionSlug: string,
  db: Database = getDb(),
): Promise<{ id: string; title: string }> => {
  const [row] = await db
    .select({ id: competitions.id, title: competitions.title })
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

  return row;
};

export const getCompetitionIdByInstitutionAndSlug = async (
  institutionSlug: string,
  competitionSlug: string,
  db: Database = getDb(),
): Promise<string> =>
  (await getCompetitionIdentityByInstitutionAndSlug(institutionSlug, competitionSlug, db)).id;

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
        inArray(institutionMemberships.membershipRole, MEMBER_ROLES), // institution_member excluded (DEC-0043)
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

  // A suspended institution cannot author new competition drafts.
  await assertInstitutionNotSuspended(institutionId, db);

  const baseSlug = input.slug ?? deriveSlugBaseFromTitle(input.title);

  // Mode defaults to individual when unspecified; team sizes are then
  // normalized to that mode so a freshly created draft never persists null/inconsistent sizes
  // (e.g. an individual competition must store 1/1, not null/null).
  const effectiveMode = input.mode ?? "individual";

  // A personal institution can only run individual-mode competitions. No-op for full
  // or legacy institutions; throws 422 competition_personal_individual_only for personal + team/both.
  await assertPersonalInstitutionIndividualMode(institutionId, effectiveMode, db);

  const { minTeamSize, maxTeamSize } = resolveTeamSizesForMode(
    effectiveMode,
    input.minTeamSize ?? null,
    input.maxTeamSize ?? null,
  );

  // Effective cancellation policy; reject allow=true with no cutoff before any DB write
  // (mirrors competitions_cancellation_policy_chk).
  const allowCancellation = input.allowCancellation ?? false;
  const cancellationCutoffDays = input.cancellationCutoffDays ?? null;
  validateCancellationPolicy(allowCancellation, cancellationCutoffDays);
  validateMinimumParticipation({
    minimumParticipantEntries: input.minimumParticipantEntries ?? null,
    participantConfirmationAt: input.participantConfirmationAt ?? null,
    registrationEndAt: input.registrationEndAt ?? null,
    eventStartAt: input.eventStartAt ?? null,
  });
  assertCompetitionTimelineChronological({
    registrationStartAt: input.registrationStartAt,
    registrationEndAt: input.registrationEndAt,
    participantConfirmationAt: input.participantConfirmationAt,
    eventStartAt: input.eventStartAt,
    eventEndAt: input.eventEndAt,
    resultAnnouncementAt: input.resultAnnouncementAt,
  });

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
          resultAnnouncementAt: input.resultAnnouncementAt ?? null,
          minimumParticipantEntries: input.minimumParticipantEntries ?? null,
          participantConfirmationAt: input.participantConfirmationAt ?? null,
          allowCancellation,
          cancellationCutoffDays,
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

// Maps the simple (non-normalized) patch columns onto an update record. Shared by the draft and
// published edit paths. Team-size normalization is layered on top by the draft path only.
const applySimplePatchColumns = (
  updates: Record<string, unknown>,
  patch: CompetitionPatchInput,
): void => {
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.slug !== undefined) updates.slug = patch.slug;
  if (patch.category !== undefined) updates.category = patch.category;
  if (patch.mode !== undefined) updates.mode = patch.mode;
  if (patch.location !== undefined) updates.location = patch.location;
  if (patch.minTeamSize !== undefined) updates.minTeamSize = patch.minTeamSize;
  if (patch.maxTeamSize !== undefined) updates.maxTeamSize = patch.maxTeamSize;
  if (patch.registrationStartAt !== undefined)
    updates.registrationStartAt = patch.registrationStartAt;
  if (patch.registrationEndAt !== undefined) updates.registrationEndAt = patch.registrationEndAt;
  if (patch.eventStartAt !== undefined) updates.eventStartAt = patch.eventStartAt;
  if (patch.eventEndAt !== undefined) updates.eventEndAt = patch.eventEndAt;
  if (patch.resultAnnouncementAt !== undefined)
    updates.resultAnnouncementAt = patch.resultAnnouncementAt;
  if (patch.minimumParticipantEntries !== undefined)
    updates.minimumParticipantEntries = patch.minimumParticipantEntries;
  if (patch.participantConfirmationAt !== undefined)
    updates.participantConfirmationAt = patch.participantConfirmationAt;
  if (patch.allowCancellation !== undefined) updates.allowCancellation = patch.allowCancellation;
  if (patch.cancellationCutoffDays !== undefined)
    updates.cancellationCutoffDays = patch.cancellationCutoffDays;
};

/**
 * A competition's pricing, read separately because PUBLIC_COMPETITION_COLUMNS omits it.
 *
 * Both the charging gate and the edit classifier need these three columns, and neither may read
 * them off a projection that excludes them: a money gate whose input is structurally absent reads
 * as free no matter what the row says.
 */
export type CompetitionPricing = {
  feeAmount: number | null;
  feeCurrency: string | null;
  paymentWindowDays: number;
};

export const loadCompetitionPricing = async (
  competitionId: string,
  db: Database,
): Promise<CompetitionPricing> => {
  const [row] = await db
    .select({
      feeAmount: competitions.feeAmount,
      feeCurrency: competitions.feeCurrency,
      paymentWindowDays: competitions.paymentWindowDays,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);

  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }

  return row;
};

export const toClassifiable = (
  row: CompetitionRow,
  pricing: CompetitionPricing,
): ClassifiableCompetition => ({
  title: row.title,
  slug: row.slug,
  description: row.description,
  category: row.category,
  mode: row.mode,
  location: row.location,
  minTeamSize: row.minTeamSize,
  maxTeamSize: row.maxTeamSize,
  registrationStartAt: row.registrationStartAt,
  registrationEndAt: row.registrationEndAt,
  eventStartAt: row.eventStartAt,
  eventEndAt: row.eventEndAt,
  resultAnnouncementAt: row.resultAnnouncementAt,
  allowCancellation: row.allowCancellation,
  cancellationCutoffDays: row.cancellationCutoffDays,
  feeAmount: pricing.feeAmount,
  feeCurrency: pricing.feeCurrency,
  paymentWindowDays: pricing.paymentWindowDays,
});

const mergeForClassification = (
  row: CompetitionRow,
  patch: CompetitionPatchInput,
  pricing: CompetitionPricing,
): ClassifiableCompetition => {
  const merged = toClassifiable(row, pricing);
  if (patch.title !== undefined) merged.title = patch.title;
  if (patch.slug !== undefined) merged.slug = patch.slug;
  if (patch.description !== undefined) merged.description = patch.description;
  if (patch.category !== undefined) merged.category = patch.category;
  if (patch.mode !== undefined) merged.mode = patch.mode;
  if (patch.location !== undefined) merged.location = patch.location;
  if (patch.minTeamSize !== undefined) merged.minTeamSize = patch.minTeamSize;
  if (patch.maxTeamSize !== undefined) merged.maxTeamSize = patch.maxTeamSize;
  if (patch.registrationStartAt !== undefined)
    merged.registrationStartAt = patch.registrationStartAt;
  if (patch.registrationEndAt !== undefined) merged.registrationEndAt = patch.registrationEndAt;
  if (patch.eventStartAt !== undefined) merged.eventStartAt = patch.eventStartAt;
  if (patch.eventEndAt !== undefined) merged.eventEndAt = patch.eventEndAt;
  if (patch.resultAnnouncementAt !== undefined)
    merged.resultAnnouncementAt = patch.resultAnnouncementAt;
  if (patch.allowCancellation !== undefined) merged.allowCancellation = patch.allowCancellation;
  if (patch.cancellationCutoffDays !== undefined)
    merged.cancellationCutoffDays = patch.cancellationCutoffDays;
  return merged;
};

// Loads the snapshot handed to the edit classifier. The classifier reads only
// hasTransferAwaitingReview from it. Team sizes are the per-team count of non-cancelled team-typed
// rows (each member holds one row).
export const loadEditClassificationSnapshot = async (
  competitionId: string,
  db: Database,
): Promise<EditClassificationSnapshot> => {
  const rows = await db
    .select({
      registrationType: competitionRegistrations.registrationType,
      teamId: competitionRegistrations.teamId,
    })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        ne(competitionRegistrations.status, "cancelled"),
      ),
    );

  const teamCounts = new Map<string, number>();
  let hasActiveIndividual = false;
  let hasActiveTeam = false;
  for (const row of rows) {
    if (row.registrationType === "team" && row.teamId) {
      hasActiveTeam = true;
      teamCounts.set(row.teamId, (teamCounts.get(row.teamId) ?? 0) + 1);
    } else {
      hasActiveIndividual = true;
    }
  }

  return {
    nonCancelledCount: rows.length,
    hasActiveIndividual,
    hasActiveTeam,
    activeTeamSizes: [...teamCounts.values()],
    hasActiveFree: await hasActiveFreeRegistrations(competitionId, db),
    hasTransferAwaitingReview: await hasCompetitionTransferAwaitingReview(competitionId, db),
  };
};

const closeWaitsForTransferReviewError = (fields: string[]): CompetitionError =>
  new CompetitionError(
    "competition_close_waits_for_transfer_review",
    409,
    CLOSE_WAITS_FOR_TRANSFER_REVIEW_REASON,
    { fields },
  );

// A proof sent after the outer classification read its snapshot is committed under this same lock,
// so reading again once the lock is held sees it.
const assertNoTransferAwaitingReviewUnderLock = async (
  tx: Database,
  competitionId: string,
): Promise<void> => {
  const transferAwaitingReview = await hasCompetitionTransferAwaitingReview(competitionId, tx);
  if (!transferAwaitingReview) return;
  throw closeWaitsForTransferReviewError(["registrationEndAt"]);
};

const immutableCompetitionValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
};

const validateChangedRegistrationEnd = (
  registrationEndAt: Date | null | undefined,
  storedRegistrationEndAt: Date | null,
): void => {
  if (immutableCompetitionValuesEqual(registrationEndAt, storedRegistrationEndAt)) return;
  validateRegistrationEndInFuture(registrationEndAt);
};

const closeMovedByPatch = (
  patch: CompetitionPatchInput,
  competition: CompetitionRow,
): Date | null => {
  if (!(patch.registrationEndAt instanceof Date)) return null;
  if (immutableCompetitionValuesEqual(patch.registrationEndAt, competition.registrationEndAt)) {
    return null;
  }
  return patch.registrationEndAt;
};

// The fields of the list whose patched value differs from the stored one. A field sent with its
// stored value changes nothing, so a form that resends it is not refused.
const fieldsChangedByPatch = (
  fieldNames: readonly string[],
  competition: CompetitionRow,
  patch: CompetitionPatchInput,
): string[] => {
  const row = competition as unknown as Record<string, unknown>;
  const patchRecord = patch as Record<string, unknown>;
  return fieldNames.filter(
    (field) =>
      field in patchRecord && !immutableCompetitionValuesEqual(patchRecord[field], row[field]),
  );
};

// Writes a published edit only onto the row it was judged against. Every writer of a competition
// sets updatedAt, so a row another request changed since this one read it matches nothing. The
// judged value came through a JavaScript Date, which keeps milliseconds, so the stored value is cut
// to milliseconds before the comparison.
const writePublishedCompetitionUpdates = (
  writer: DbOrTx,
  competitionId: string,
  judgedUpdatedAt: Date,
  updates: Record<string, unknown>,
) =>
  writer
    .update(competitions)
    .set(updates)
    .where(
      and(
        eq(competitions.id, competitionId),
        sql`date_trunc('milliseconds', ${competitions.updatedAt}) = ${judgedUpdatedAt.toISOString()}`,
      ),
    )
    .returning(PUBLIC_COMPETITION_COLUMNS);

// Writes a draft edit only while the competition is still a draft, so a publish that commits first
// leaves the edit matching nothing.
const writeDraftCompetitionUpdates = (
  writer: DbOrTx,
  competitionId: string,
  updates: Record<string, unknown>,
) =>
  writer
    .update(competitions)
    .set(updates)
    .where(and(eq(competitions.id, competitionId), eq(competitions.status, "draft")))
    .returning(PUBLIC_COMPETITION_COLUMNS);

// The team sizes a patch leaves the competition with, normalized to its mode, or null when the
// patch touches neither the mode nor a size. Catches what the patch parse cannot see, such as a
// team minimum patched alone on a team-mode row, and refuses a team minimum below the floor rather
// than raising it.
const resolvePatchedTeamSizes = (
  patch: CompetitionPatchInput,
  competition: CompetitionRow,
): { minTeamSize: number; maxTeamSize: number } | null => {
  const effectiveMode = patch.mode !== undefined ? patch.mode : competition.mode;
  const patchTouchesSizeOrMode =
    patch.mode !== undefined || patch.minTeamSize !== undefined || patch.maxTeamSize !== undefined;
  if (!effectiveMode || !patchTouchesSizeOrMode) return null;
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
  return resolveTeamSizesForMode(effectiveMode, effectiveMin, effectiveMax);
};

// Post-publish edit path. Two layers:
//   outer (locked): IMMUTABLE_AFTER_PUBLISH fields can never change → 422.
//   inner (classifier): each remaining change is refused or announced, by its field and direction.
// blocked → refuse; waitsForTransferReview → refuse until the transfer is decided;
// notify → persist + fan out competition.edited.
const updatePublishedCompetition = async (
  competition: CompetitionRow,
  patch: CompetitionPatchInput,
  db: Database,
): Promise<CompetitionRow> => {
  const immutableChanged = fieldsChangedByPatch(IMMUTABLE_AFTER_PUBLISH, competition, patch);
  if (immutableChanged.length > 0) {
    throw new CompetitionError(
      "competition_field_immutable",
      422,
      `Cannot modify immutable field(s) on a published competition: ${immutableChanged.join(", ")}`,
      { fields: immutableChanged },
    );
  }

  validateChangedRegistrationEnd(patch.registrationEndAt, competition.registrationEndAt);
  const pricing = await loadCompetitionPricing(competition.id, db);
  const movedClose = closeMovedByPatch(patch, competition);
  const merged = mergeForClassification(competition, patch, pricing);
  const teamSizes = resolvePatchedTeamSizes(patch, competition);
  if (teamSizes !== null) {
    merged.minTeamSize = teamSizes.minTeamSize;
    merged.maxTeamSize = teamSizes.maxTeamSize;
  }
  validateCancellationPolicy(merged.allowCancellation, merged.cancellationCutoffDays);
  validateMinimumParticipation({
    minimumParticipantEntries: competition.minimumParticipantEntries,
    participantConfirmationAt: competition.participantConfirmationAt,
    registrationEndAt:
      patch.registrationEndAt !== undefined
        ? patch.registrationEndAt
        : competition.registrationEndAt,
    eventStartAt: patch.eventStartAt !== undefined ? patch.eventStartAt : competition.eventStartAt,
  });
  assertCompetitionTimelineChronological({
    registrationStartAt:
      patch.registrationStartAt !== undefined
        ? patch.registrationStartAt
        : competition.registrationStartAt,
    registrationEndAt:
      patch.registrationEndAt !== undefined
        ? patch.registrationEndAt
        : competition.registrationEndAt,
    participantConfirmationAt: competition.participantConfirmationAt,
    eventStartAt: patch.eventStartAt !== undefined ? patch.eventStartAt : competition.eventStartAt,
    eventEndAt: patch.eventEndAt !== undefined ? patch.eventEndAt : competition.eventEndAt,
    resultAnnouncementAt:
      patch.resultAnnouncementAt !== undefined
        ? patch.resultAnnouncementAt
        : competition.resultAnnouncementAt,
  });

  // A published competition may not be edited into a state it could not have been published in.
  // Clearing eventEndAt is the case that matters most: the competition's whole post-event
  // lifecycle — when results become due, and when its documents are purged — is measured from
  // that date, so losing it would take the competition outside both windows entirely.
  const missingRequired = findMissingPublishFields({
    ...merged,
    minimumParticipantEntries: competition.minimumParticipantEntries,
    participantConfirmationAt: competition.participantConfirmationAt,
  }).filter((failure) => {
    // Competitions published before these two fields became mandatory are grandfathered for
    // unrelated edits. New publishes cannot omit them, and an existing value still cannot be
    // cleared after publication.
    if (failure.field === "resultAnnouncementAt") {
      return competition.resultAnnouncementAt !== null;
    }
    if (failure.field === "participantConfirmationAt") {
      return competition.participantConfirmationAt !== null;
    }
    return true;
  });
  if (missingRequired.length > 0) {
    throw new CompetitionError(
      "competition_publish_validation_failed",
      422,
      `Cannot clear required field(s) on a published competition: ${missingRequired
        .map((failure) => failure.field)
        .join(", ")}`,
      { fields: missingRequired.map((failure) => failure.field), failures: missingRequired },
    );
  }

  const snapshot = await loadEditClassificationSnapshot(competition.id, db);
  const classification = classifyCompetitionEdit(
    toClassifiable(competition, pricing),
    merged,
    snapshot,
  );

  if (classification.blocked.length > 0) {
    throw new CompetitionError(
      "competition_post_publish_blocked",
      422,
      `Cannot apply edit: ${classification.blocked.join(", ")} cannot move this way after publish`,
      { fields: classification.blocked, blockedFields: classification.blocked },
    );
  }

  if (classification.waitsForTransferReview.length > 0) {
    throw closeWaitsForTransferReviewError(classification.waitsForTransferReview);
  }

  const updates: Record<string, unknown> = { updatedAt: sql`now()` };
  applySimplePatchColumns(updates, patch);
  if (teamSizes !== null) {
    updates.minTeamSize = teamSizes.minTeamSize;
    updates.maxTeamSize = teamSizes.maxTeamSize;
  }

  if (Object.keys(updates).length === 1) {
    return competition;
  }

  // The app clock, which every reader of an invite's expiry compares with.
  const now = new Date();
  let updated: CompetitionRow;
  try {
    // The lock orders the move with an invite, an accept and a team registering, which read the
    // close under the same lock, so no open invite keeps the old close. A write that matched no row
    // moved no close, so it moves no invite.
    const [persisted] =
      movedClose === null
        ? await writePublishedCompetitionUpdates(db, competition.id, competition.updatedAt, updates)
        : await db.transaction(async (tx) => {
            await acquireCompetitionParticipationLock(tx, competition.id);
            await assertNoTransferAwaitingReviewUnderLock(tx, competition.id);
            const rows = await writePublishedCompetitionUpdates(
              tx,
              competition.id,
              competition.updatedAt,
              updates,
            );
            if (rows.length === 0) return rows;
            await moveOpenTeamInvitationsToClose(tx, competition.id, movedClose, now);
            return rows;
          });
    if (!persisted) {
      throw new CompetitionError(
        "competition_changed_during_edit",
        409,
        COMPETITION_CHANGED_DURING_EDIT_REASON,
      );
    }
    updated = persisted;
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

  // Notify-bucket change → dual-channel fan-out. Fire-and-forget with an epoch idempotency key;
  // an enqueue failure must not fail the edit (DEC-0076 isolation).
  if (classification.notify.length > 0) {
    enqueueCompetitionEdited({
      competitionId: competition.id,
      changedFields: classification.notify,
      epoch: Date.now(),
    }).catch((err) => {
      logger.warn("competition.edited.enqueue-failed", {
        competitionId: competition.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return updated;
};

export const updateCompetitionDraft = async (
  actorUserId: string,
  competitionId: string,
  patch: CompetitionPatchInput,
  db: Database = getDb(),
): Promise<CompetitionRow> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);

  // Published competitions are edited in place through the classifier, which judges each change by
  // its field and direction.
  if (competition.status === "published") {
    const changedPublicFields = fieldsChangedByPatch(
      PUBLIC_FIELDS_HELD_AFTER_TRUST_REMOVAL,
      competition,
      patch,
    );
    await assertPublicFieldsUnchangedByRemovedHost(actorUserId, changedPublicFields, db);
    return updatePublishedCompetition(competition, patch, db);
  }

  // Archived (and any non-draft, non-published) competitions remain non-editable. Defensive
  // immutable-field check first so callers distinguish "never editable" from "terminal state".
  if (competition.status !== "draft") {
    const immutableChanged = fieldsChangedByPatch(IMMUTABLE_AFTER_PUBLISH, competition, patch);
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
      `Cannot edit fields on a ${competition.status} competition.`,
      { fields: lockedFields },
    );
  }

  validateRegistrationEndInFuture(patch.registrationEndAt);

  // A draft edit may not move a personal-owned competition off individual mode.
  // Only checked when the patch actually touches mode (no-op for full/legacy institutions).
  if (patch.mode !== undefined) {
    await assertPersonalInstitutionIndividualMode(competition.institutionId, patch.mode, db);
  }

  const updates: Record<string, unknown> = { updatedAt: sql`now()` };
  applySimplePatchColumns(updates, patch);

  // Validate the effective cancellation policy across patch + existing row.
  const effectiveAllowCancellation =
    patch.allowCancellation !== undefined ? patch.allowCancellation : competition.allowCancellation;
  const effectiveCutoffDays =
    patch.cancellationCutoffDays !== undefined
      ? patch.cancellationCutoffDays
      : competition.cancellationCutoffDays;
  validateCancellationPolicy(effectiveAllowCancellation, effectiveCutoffDays);
  validateMinimumParticipation({
    minimumParticipantEntries:
      patch.minimumParticipantEntries !== undefined
        ? patch.minimumParticipantEntries
        : competition.minimumParticipantEntries,
    participantConfirmationAt:
      patch.participantConfirmationAt !== undefined
        ? patch.participantConfirmationAt
        : competition.participantConfirmationAt,
    registrationEndAt:
      patch.registrationEndAt !== undefined
        ? patch.registrationEndAt
        : competition.registrationEndAt,
    eventStartAt: patch.eventStartAt !== undefined ? patch.eventStartAt : competition.eventStartAt,
  });
  assertCompetitionTimelineChronological({
    registrationStartAt:
      patch.registrationStartAt !== undefined
        ? patch.registrationStartAt
        : competition.registrationStartAt,
    registrationEndAt:
      patch.registrationEndAt !== undefined
        ? patch.registrationEndAt
        : competition.registrationEndAt,
    participantConfirmationAt:
      patch.participantConfirmationAt !== undefined
        ? patch.participantConfirmationAt
        : competition.participantConfirmationAt,
    eventStartAt: patch.eventStartAt !== undefined ? patch.eventStartAt : competition.eventStartAt,
    eventEndAt: patch.eventEndAt !== undefined ? patch.eventEndAt : competition.eventEndAt,
    resultAnnouncementAt:
      patch.resultAnnouncementAt !== undefined
        ? patch.resultAnnouncementAt
        : competition.resultAnnouncementAt,
  });

  const teamSizes = resolvePatchedTeamSizes(patch, competition);
  if (teamSizes !== null) {
    updates.minTeamSize = teamSizes.minTeamSize;
    updates.maxTeamSize = teamSizes.maxTeamSize;
  }

  // Nothing besides the timestamp — no-op fast path.
  if (Object.keys(updates).length === 1) {
    return competition;
  }

  const movedClose = closeMovedByPatch(patch, competition);
  // The app clock, which every reader of an invite's expiry compares with.
  const now = new Date();
  try {
    // Open team invites expire at the close, so a moved close moves them in the same transaction,
    // under the lock an invite and an accept take. A write that matched no row moves no invite.
    const [row] =
      movedClose === null
        ? await writeDraftCompetitionUpdates(db, competitionId, updates)
        : await db.transaction(async (tx) => {
            await acquireCompetitionParticipationLock(tx, competitionId);
            const rows = await writeDraftCompetitionUpdates(tx, competitionId, updates);
            if (rows.length === 0) return rows;
            await moveOpenTeamInvitationsToClose(tx, competitionId, movedClose, now);
            return rows;
          });
    if (!row) {
      throw new CompetitionError(
        "competition_changed_during_edit",
        409,
        COMPETITION_CHANGED_DURING_EDIT_REASON,
      );
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

// Soft-delete a draft. A published competition is not deletable via DELETE — it must be
// unpublished back to draft first, which cancels its registrations explicitly rather than
// stranding them.
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
  // Owners and institution_staff publish, a paid draft included.
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);

  // Same-status transitions are rejected as invalid: ALLOWED_TRANSITIONS does not contain any
  // from===to edge (e.g. published → published).
  if (!isAllowedStatusTransition(competition.status, targetStatus)) {
    throw new CompetitionError(
      "competition_invalid_transition",
      422,
      `Cannot transition competition from '${competition.status}' to '${targetStatus}'`,
    );
  }

  // DEC-0132, DEC-0271: published → draft stays a defined move, but this primitive writes only the
  // status. DEC-0271 states that no path takes a competition with a proof pending or verified back
  // to draft.
  // Unpublishing also cancels the registrations and refuses while money is in flight, and only
  // unpublishCompetition does both.
  if (competition.status === "published" && targetStatus === "draft") {
    throw new CompetitionError(
      "competition_invalid_transition",
      422,
      "Unpublishing goes through unpublishCompetition, which refuses while a transfer proof is pending review or verified",
    );
  }

  // Publish guards: the institution must not be suspended, the publish-validation checklist must
  // pass, and the actor must be trusted, checked last. Validation runs against the merged DB row
  // (not caller payload) so partial PATCHes that left the row internally inconsistent are caught
  // here. This is the second gate referenced in DEC-0028.
  if (competition.status === "draft" && targetStatus === "published") {
    await assertInstitutionNotSuspended(competition.institutionId, db);
    const result = validatePublishChecklist({
      title: competition.title,
      description: competition.description,
      category: competition.category,
      mode: competition.mode,
      location: competition.location,
      minTeamSize: competition.minTeamSize,
      maxTeamSize: competition.maxTeamSize,
      registrationStartAt: competition.registrationStartAt,
      registrationEndAt: competition.registrationEndAt,
      eventStartAt: competition.eventStartAt,
      eventEndAt: competition.eventEndAt,
      resultAnnouncementAt: competition.resultAnnouncementAt,
      minimumParticipantEntries: competition.minimumParticipantEntries,
      participantConfirmationAt: competition.participantConfirmationAt,
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

    await assertCompetitionHasOrganizerContact(competitionId, db);
    await assertCompetitionHasAudience(competitionId, db);

    // THE CHARGING GATE AT PUBLISH (DEC-0158). A PAID competition cannot go live for an
    // institution that is not verified; a FREE one publishes normally, which is the whole point of
    // the distinction: verification gates the right to charge, never the right to publish.
    //
    // Read here rather than taken from `competition`, because PUBLIC_COMPETITION_COLUMNS
    // deliberately omits the fee fields (DEC-0022) and a projection that excludes the value cannot
    // be the thing a money gate reads.
    const pricing = await loadCompetitionPricing(competitionId, db);

    if (isPaidCompetition(pricing.feeAmount)) {
      await assertInstitutionVerified(competition.institutionId, db);
    }

    // Personal-institution reach cap: at most MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL
    // competitions may be in published status at once, and the mode must be individual. No-op for
    // full or legacy institutions.
    await assertPersonalCompetitionPublishable(
      { id: competition.id, institutionId: competition.institutionId, mode: competition.mode },
      db,
    );

    // Last, so an untrusted host's press opens a host check only for a draft that passes every
    // other check.
    await assertPublishTrustSatisfied(actorUserId, competition.institutionId, db);
  }

  // This function writes only draft → published. Unpublish (published → draft) is
  // unpublishCompetition, which cancels every active registration inside one transaction.

  const updates: Record<string, unknown> = {
    status: targetStatus,
    updatedAt: sql`now()`,
  };
  if (targetStatus === "published") updates.publishedAt = new Date();
  // publishedAt records the first-publication timestamp as historical metadata, useful for audit
  // and discovery signals. unpublishCompetition preserves it (DEC-0030).

  // An account deletion can clear the contact after the gate above read it, so the publish write
  // itself refuses a row without one (Rule 25).
  const contactStillSet =
    targetStatus === "published" ? isNotNull(competitions.organizerContactValue) : undefined;
  // A staff member can clear the location or the audience between the checks above and this write.
  const listingFieldsStillSet =
    targetStatus === "published"
      ? and(isNotNull(competitions.location), sql`cardinality(${competitions.audience}) > 0`)
      : undefined;

  // CAS guard: WHERE also checks current status equals the snapshot status to prevent
  // concurrent transitions from landing on top of each other.
  const [row] = await db
    .update(competitions)
    .set(updates)
    .where(
      and(
        eq(competitions.id, competitionId),
        eq(competitions.status, competition.status),
        contactStillSet,
        listingFieldsStillSet,
      ),
    )
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

  // Enqueue search index sync. publish → upsert; anything else → remove.
  // The enqueue is fire-and-forget: a failure to enqueue (e.g. Redis unavailable) must not
  // fail the transition itself. The sync job handles its own retry via BullMQ backoff.
  const syncAction = targetStatus === "published" ? "upsert" : "remove";
  enqueueCompetitionSearchSync({ competitionId, action: syncAction }).catch((err) => {
    logger.error("competition.search-sync.enqueue-failed", {
      competitionId,
      action: syncAction,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { competition: row };
};

export type UnpublishCompetitionResult = {
  competition: CompetitionRow;
  cancelledCount: number;
};

// Unpublish-as-cancellation. Transitions a published competition back to draft, cancels every
// non-cancelled registration, marks every registration as made in a publication that has ended and
// disbands every team, in one transaction (rows are never hard-deleted,
// status='cancelled' is terminal). publishedAt is preserved (DEC-0030). After commit, fans out the
// competition.cancelled dual-channel notice (recipients re-derived at job-run from the institution
// cancellation reason) and removes the competition from the search index. The competition row
// remains queryable to platform_ops; this is not a soft-delete of the competition.
export const unpublishCompetition = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
  now?: Date,
): Promise<UnpublishCompetitionResult> => {
  await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  await assertWithdrawalNotByRemovedHost(actorUserId, db);

  const result = await db.transaction(async (tx) => {
    await acquireCompetitionParticipationLock(tx, competitionId);
    const mutationAt = now ?? new Date();
    const [competition] = await tx
      .select(PUBLIC_COMPETITION_COLUMNS)
      .from(competitions)
      .where(eq(competitions.id, competitionId))
      .limit(1);

    if (!competition) {
      throw new CompetitionError("competition_not_found", 404, "Competition not found");
    }
    if (competition.status !== "published") {
      throw new CompetitionError(
        "competition_invalid_transition",
        422,
        `Cannot unpublish a competition in '${competition.status}' status`,
      );
    }
    if (competition.cancelledAt) {
      throw new CompetitionError(
        "competition_already_cancelled",
        409,
        "A cancelled competition must remain published as a public record",
      );
    }
    if (
      isParticipantCancellationClosedByConfirmation(
        competition.participantConfirmationAt,
        mutationAt,
      )
    ) {
      throw new CompetitionError(
        "competition_unpublish_blocked_after_participation_confirmation",
        422,
        "Cannot withdraw a competition after participantConfirmationAt",
        { fields: ["participantConfirmationAt"] },
      );
    }

    // UNPUBLISH IS BLOCKED WHILE MONEY IS IN FLIGHT (DEC-0132).
    //
    // Placed BEFORE the status CAS and the registration cancellation below, which is the whole
    // point: this function's next act is to cancel every registration on the competition, and a
    // candidate who has already transferred real rupiah to the organiser's bank account would be
    // cancelled with their money gone and no in-app record that they are owed anything.
    //
    // Keyed off PAYMENT IN FLIGHT rather than confirmed-paid, deliberately. The dangerous window is
    // the one where the transfer has happened but the organiser has not verified it yet, and the
    // narrower predicate would let exactly that case through.
    //
    // The message names the way out, resolving each transfer, because an operator's cancellation
    // holds to the same block.
    if (await hasCompetitionPaymentInFlight(competitionId, tx)) {
      throw new CompetitionError(
        "competition_unpublish_blocked_payment_in_flight",
        409,
        "Kompetisi tidak dapat ditarik selama masih ada bukti transfer yang menunggu verifikasi atau sudah diverifikasi. Verifikasi atau tolak dulu setiap bukti yang menunggu. Kompetisi dengan transfer yang sudah diverifikasi tidak dapat ditarik.",
      );
    }

    // Once the event has started, withdrawal is refused for as long as anyone is registered: this
    // call cancels every registration and takes the public page down with it, which abandons
    // participants mid-competition. With nobody registered there is nobody to strand.
    if (hasCompetitionStarted(competition.eventStartAt, mutationAt)) {
      const hasRegistrations = await hasActiveRegistrationsForCompetition(competitionId, tx);
      if (hasRegistrations) {
        throw new CompetitionError(
          "competition_unpublish_blocked_after_start",
          422,
          "Cannot unpublish a competition that has started and has active registrations — edit it instead",
          { fields: ["eventStartAt"] },
        );
      }
    }

    // CAS: re-check status='published' in the WHERE so a concurrent transition rolls this back.
    const [statusRow] = await tx
      .update(competitions)
      .set({ status: "draft", updatedAt: mutationAt })
      .where(and(eq(competitions.id, competitionId), eq(competitions.status, "published")))
      .returning(PUBLIC_COMPETITION_COLUMNS);

    if (!statusRow) {
      throw new CompetitionError(
        "competition_invalid_transition",
        422,
        "Competition status was modified concurrently — reload and retry the unpublish",
      );
    }

    // Cancel every non-cancelled registration (individual + team member rows are flat, so a single
    // UPDATE covers both). Already-cancelled rows are left untouched, preserving their own reason.
    const cancelledRows = await tx
      .update(competitionRegistrations)
      .set({
        status: "cancelled",
        cancellationReason: INSTITUTION_CANCELLATION_REASON,
        cancelledAt: mutationAt,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(competitionRegistrations.competitionId, competitionId),
          ne(competitionRegistrations.status, "cancelled"),
        ),
      )
      .returning({ id: competitionRegistrations.id });

    await markCompetitionRegistrationsPublicationClosed(competitionId, mutationAt, tx);
    await disbandEveryTeamOfCompetition(competitionId, mutationAt, tx);

    return {
      competition: statusRow,
      cancelledCount: cancelledRows.length,
      cancellationAt: mutationAt,
    };
  });

  logger.info("competition.unpublished", {
    competitionId,
    actorUserId,
    cancelledRegistrations: result.cancelledCount,
  });

  // Fire-and-forget post-commit dispatch — neither enqueue failure may fail the unpublish.
  enqueueCompetitionSearchSync({ competitionId, action: "remove" }).catch((err) => {
    logger.error("competition.search-sync.enqueue-failed", {
      competitionId,
      action: "remove",
      error: err instanceof Error ? err.message : String(err),
    });
  });
  enqueueCompetitionCancelled({ competitionId, epoch: result.cancellationAt.getTime() }).catch(
    (err) => {
      logger.warn("competition.cancelled.enqueue-failed", {
        competitionId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  return { competition: result.competition, cancelledCount: result.cancelledCount };
};
