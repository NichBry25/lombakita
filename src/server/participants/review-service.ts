// Institution-internal review state on competition registrations (Step 5.2).
//
// This surface is entirely institution-internal: it reads and writes
// `internal_review_status` / `internal_notes` on competition_registrations and
// NEVER touches the candidate-visible `status` column. Access is gated at the
// route layer via requireAdminInstitutionBySlug; this service additionally
// enforces competition ownership so a cross-institution registrationId collapses
// to a 404 with no information leak (same pattern as participant-service.ts).

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  competitionRegistrations,
  competitionRegistrationReviewStatusEnum,
  institutionAuditLogs,
  teams,
  teamMemberships,
  type CompetitionRegistrationReviewStatus,
  type CompetitionRegistrationType,
} from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/participants/review-service");

export type ReviewErrorCode =
  | "review_invalid_payload"
  | "review_invalid_status"
  | "review_registration_not_found";

export class ReviewError extends Error {
  constructor(
    public readonly code: ReviewErrorCode,
    public readonly httpStatus: 400 | 404 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export const toReviewErrorResponse = (error: ReviewError): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.httpStatus },
  );

// Fields returned by both read and write paths.
export type RegistrationReviewFields = {
  internalReviewStatus: CompetitionRegistrationReviewStatus;
  internalNotes: string | null;
};

// Extended shape returned by getRegistrationReview for the sub-page. Includes
// registration context so the UI can show a team label when applicable.
export type RegistrationReviewContext = RegistrationReviewFields & {
  registrationType: CompetitionRegistrationType;
  teamName: string | null;
  activeMemberCount: number | null;
};

export type ReviewUpdatePatch = {
  internalReviewStatus?: CompetitionRegistrationReviewStatus;
  internalNotes?: string | null;
};

const REVIEW_STATUS_VALUES = competitionRegistrationReviewStatusEnum.enumValues;
const REVIEW_STATUS_SET = new Set<string>(REVIEW_STATUS_VALUES);
const NOTES_MAX_LENGTH = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse a partial review-update payload. Either field may be absent, but at least
 * one must be present. Unknown keys, a non-object body, or a wrong-typed note are
 * 400 (review_invalid_payload). An unrecognised status value is 422
 * (review_invalid_status).
 */
export const parseReviewUpdatePayload = (payload: unknown): ReviewUpdatePatch => {
  if (!isRecord(payload)) {
    throw new ReviewError("review_invalid_payload", 400, "Request body must be a JSON object");
  }

  const allowedKeys = new Set(["internalReviewStatus", "internalNotes"]);
  const unknownKeys = Object.keys(payload).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new ReviewError(
      "review_invalid_payload",
      400,
      "Request body contains unsupported fields",
    );
  }

  const hasStatus = "internalReviewStatus" in payload;
  const hasNotes = "internalNotes" in payload;
  if (!hasStatus && !hasNotes) {
    throw new ReviewError(
      "review_invalid_payload",
      400,
      "At least one of internalReviewStatus or internalNotes is required",
    );
  }

  const patch: ReviewUpdatePatch = {};

  if (hasStatus) {
    const raw = payload.internalReviewStatus;
    if (typeof raw !== "string" || !REVIEW_STATUS_SET.has(raw)) {
      throw new ReviewError(
        "review_invalid_status",
        422,
        "internalReviewStatus must be one of: " + REVIEW_STATUS_VALUES.join(", "),
      );
    }
    patch.internalReviewStatus = raw as CompetitionRegistrationReviewStatus;
  }

  if (hasNotes) {
    const raw = payload.internalNotes;
    if (raw === null) {
      patch.internalNotes = null;
    } else if (typeof raw === "string") {
      if (raw.length > NOTES_MAX_LENGTH) {
        throw new ReviewError(
          "review_invalid_payload",
          400,
          `internalNotes must be at most ${NOTES_MAX_LENGTH} characters`,
        );
      }
      patch.internalNotes = raw;
    } else {
      throw new ReviewError(
        "review_invalid_payload",
        400,
        "internalNotes must be a string or null",
      );
    }
  }

  return patch;
};

/**
 * Confirm `competitionId` belongs to `institutionId`. Returns false on mismatch;
 * callers translate that to a 404 (no information leak).
 */
const ownsCompetition = async (
  institutionId: string,
  competitionId: string,
  db: Database,
): Promise<boolean> => {
  const [comp] = await db
    .select({ id: competitions.id })
    .from(competitions)
    .where(and(eq(competitions.id, competitionId), eq(competitions.institutionId, institutionId)))
    .limit(1);
  return Boolean(comp);
};

/**
 * Read the current review fields plus registration context for the sub-page.
 * Returns null when the competition is not owned by the institution or the
 * registration does not belong to the competition.
 */
export const getRegistrationReview = async (
  institutionId: string,
  competitionId: string,
  registrationId: string,
  db: Database = getDb(),
): Promise<RegistrationReviewContext | null> => {
  if (!(await ownsCompetition(institutionId, competitionId, db))) return null;

  const [row] = await db
    .select({
      internalReviewStatus: competitionRegistrations.internalReviewStatus,
      internalNotes: competitionRegistrations.internalNotes,
      registrationType: competitionRegistrations.registrationType,
      teamId: competitionRegistrations.teamId,
      teamName: teams.name,
    })
    .from(competitionRegistrations)
    .leftJoin(teams, eq(teams.id, competitionRegistrations.teamId))
    .where(
      and(
        eq(competitionRegistrations.id, registrationId),
        eq(competitionRegistrations.competitionId, competitionId),
      ),
    )
    .limit(1);

  if (!row) return null;

  let activeMemberCount: number | null = null;
  if (row.teamId) {
    const [countRow] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.teamId, row.teamId), eq(teamMemberships.status, "active")));
    activeMemberCount = countRow?.count ?? 0;
  }

  return {
    internalReviewStatus: row.internalReviewStatus,
    internalNotes: row.internalNotes,
    registrationType: row.registrationType,
    teamName: row.teamName ?? null,
    activeMemberCount,
  };
};

/**
 * Apply a partial review update to a single registration. Enforces institution
 * ownership of the competition and that the registration belongs to that
 * competition; either mismatch throws review_registration_not_found (404). Never
 * modifies the candidate-visible `status` column.
 * Writes a review_status_changed audit log entry inside the same transaction (5.4 / 5.2-D3).
 */
export const updateRegistrationReview = async (
  institutionId: string,
  competitionId: string,
  registrationId: string,
  patch: ReviewUpdatePatch,
  actorMembershipId: string,
  db: Database = getDb(),
): Promise<RegistrationReviewFields> => {
  if (!(await ownsCompetition(institutionId, competitionId, db))) {
    throw new ReviewError("review_registration_not_found", 404, "Registration not found");
  }

  // Load the registration to determine if it's a team so we can update all members atomically.
  const [reg] = await db
    .select({
      registrationType: competitionRegistrations.registrationType,
      teamId: competitionRegistrations.teamId,
    })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.id, registrationId),
        eq(competitionRegistrations.competitionId, competitionId),
      ),
    )
    .limit(1);

  if (!reg) {
    throw new ReviewError("review_registration_not_found", 404, "Registration not found");
  }

  // Team review is all-or-nothing: update every member row that shares this team_id.
  // Individual review targets only the one row.
  // `patch` carries only the fields present in the request (parse-enforced: at least one).
  // Spreading it sets exactly those columns; `status` is never among them.
  const targetWhere = reg.teamId
    ? and(
        eq(competitionRegistrations.competitionId, competitionId),
        eq(competitionRegistrations.teamId, reg.teamId),
      )!
    : and(
        eq(competitionRegistrations.id, registrationId),
        eq(competitionRegistrations.competitionId, competitionId),
      )!;

  const row = await db.transaction(async (tx) => {
    const updated = await tx
      .update(competitionRegistrations)
      .set({ ...patch, updatedAt: new Date() })
      .where(targetWhere)
      .returning({
        internalReviewStatus: competitionRegistrations.internalReviewStatus,
        internalNotes: competitionRegistrations.internalNotes,
      });

    const result = updated[0];
    if (!result) {
      throw new ReviewError("review_registration_not_found", 404, "Registration not found");
    }

    await tx.insert(institutionAuditLogs).values({
      institutionId,
      targetMembershipId: actorMembershipId,
      action: "review_status_changed",
      metadata: {
        competitionId,
        registrationId,
        registrationType: reg.registrationType,
        newStatus: patch.internalReviewStatus ?? null,
        ...(reg.teamId ? { teamId: reg.teamId } : {}),
      },
    });

    return result;
  });

  return row;
};
