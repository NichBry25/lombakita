// Competition result publication service (Step 5.3).
//
// Institution-controlled publication of competition results. A result row is
// draft by default and transitions to published when the institution explicitly
// publishes it. Candidates can only see result_label and result_notes for their
// own registration's result once it is published — all other fields (result_status,
// published_at, internal_review_status, internal_notes) are institution-internal.
//
// Access invariant: all functions verify institution ownership of the competition
// before any read or write. Cross-institution registrationId collapses to 404 with
// no information leak.

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  competitionRegistrations,
  competitionResults,
  institutionAuditLogs,
  institutions,
  teams,
  type CompetitionResultStatus,
  type CompetitionRegistrationType,
} from "@/server/db/schema";
import { isNotNull } from "drizzle-orm";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/participants/result-service");

// ─── Error types ────────────────────────────────────────────────────────────

export type ResultErrorCode =
  | "result_invalid_payload"
  | "result_invalid_status"
  | "result_label_required"
  | "result_registration_not_found"
  | "result_already_published";

export class ResultError extends Error {
  constructor(
    public readonly code: ResultErrorCode,
    public readonly httpStatus: 400 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ResultError";
  }
}

export const toResultErrorResponse = (error: ResultError): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.httpStatus },
  );

// ─── Public shapes ──────────────────────────────────────────────────────────

export type ResultInstitutionView = {
  id: string;
  registrationId: string;
  competitionId: string;
  resultStatus: CompetitionResultStatus;
  resultLabel: string | null;
  resultNotes: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ResultRegistrationContext = ResultInstitutionView & {
  registrationType: CompetitionRegistrationType;
  teamName: string | null;
  activeMemberCount: number | null;
};

// Only these two fields are surfaced to candidates — all status/audit fields are excluded.
export type ResultCandidateView = {
  resultLabel: string;
  resultNotes: string | null;
};

export type ResultDraftInput = {
  resultLabel?: string | null;
  resultNotes?: string | null;
};

// ─── Validation ─────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseResultDraftInput = (payload: unknown): ResultDraftInput => {
  if (!isRecord(payload)) {
    throw new ResultError("result_invalid_payload", 400, "Request body must be a JSON object");
  }

  const allowedKeys = new Set(["resultLabel", "resultNotes"]);
  const unknownKeys = Object.keys(payload).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new ResultError(
      "result_invalid_payload",
      400,
      "Request body contains unsupported fields",
    );
  }

  const input: ResultDraftInput = {};

  if ("resultLabel" in payload) {
    const raw = payload.resultLabel;
    if (raw === null || raw === undefined) {
      input.resultLabel = null;
    } else if (typeof raw === "string") {
      input.resultLabel = raw;
    } else {
      throw new ResultError("result_invalid_payload", 400, "resultLabel must be a string or null");
    }
  }

  if ("resultNotes" in payload) {
    const raw = payload.resultNotes;
    if (raw === null || raw === undefined) {
      input.resultNotes = null;
    } else if (typeof raw === "string") {
      input.resultNotes = raw;
    } else {
      throw new ResultError("result_invalid_payload", 400, "resultNotes must be a string or null");
    }
  }

  return input;
};

// ─── Ownership check ─────────────────────────────────────────────────────────

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

// ─── Registration context loader ─────────────────────────────────────────────

type RegistrationMeta = {
  registrationType: CompetitionRegistrationType;
  teamId: string | null;
  teamName: string | null;
};

const loadRegistrationMeta = async (
  competitionId: string,
  registrationId: string,
  db: Database,
): Promise<RegistrationMeta | null> => {
  const [row] = await db
    .select({
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
  return {
    registrationType: row.registrationType,
    teamId: row.teamId,
    teamName: row.teamName ?? null,
  };
};

// ─── Service functions ───────────────────────────────────────────────────────

/**
 * Read the current result (if any) for a registration, including registration context.
 * Returns null when the competition is not owned by the institution or the registration
 * does not belong to the competition.
 */
export const getResultForInstitution = async (
  institutionId: string,
  competitionId: string,
  registrationId: string,
  db: Database = getDb(),
): Promise<ResultRegistrationContext | null> => {
  if (!(await ownsCompetition(institutionId, competitionId, db))) return null;

  const meta = await loadRegistrationMeta(competitionId, registrationId, db);
  if (!meta) return null;

  let activeMemberCount: number | null = null;
  if (meta.teamId) {
    const [countRow] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(
      db
        .select({ id: competitionRegistrations.id })
        .from(competitionRegistrations)
        .where(
          and(
            eq(competitionRegistrations.teamId, meta.teamId),
            eq(competitionRegistrations.competitionId, competitionId),
          ),
        )
        .as("members"),
    );
    activeMemberCount = countRow?.count ?? 0;
  }

  const [result] = await db
    .select({
      id: competitionResults.id,
      registrationId: competitionResults.registrationId,
      competitionId: competitionResults.competitionId,
      resultStatus: competitionResults.resultStatus,
      resultLabel: competitionResults.resultLabel,
      resultNotes: competitionResults.resultNotes,
      publishedAt: competitionResults.publishedAt,
      createdAt: competitionResults.createdAt,
      updatedAt: competitionResults.updatedAt,
    })
    .from(competitionResults)
    .where(eq(competitionResults.registrationId, registrationId))
    .limit(1);

  const baseResult: ResultInstitutionView = result ?? {
    id: "",
    registrationId,
    competitionId,
    resultStatus: "draft",
    resultLabel: null,
    resultNotes: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    ...baseResult,
    registrationType: meta.registrationType,
    teamName: meta.teamName,
    activeMemberCount,
  };
};

/**
 * Create or update a draft result. Rejected if the result is already published —
 * callers must unpublish first. Uses INSERT ... ON CONFLICT DO UPDATE semantics.
 */
export const upsertResultDraft = async (
  institutionId: string,
  competitionId: string,
  registrationId: string,
  input: ResultDraftInput,
  db: Database = getDb(),
): Promise<ResultInstitutionView> => {
  if (!(await ownsCompetition(institutionId, competitionId, db))) {
    throw new ResultError("result_registration_not_found", 404, "Registration not found");
  }

  const meta = await loadRegistrationMeta(competitionId, registrationId, db);
  if (!meta) {
    throw new ResultError("result_registration_not_found", 404, "Registration not found");
  }

  // Reject upsert if the result is already published — callers must unpublish first.
  const [existing] = await db
    .select({ resultStatus: competitionResults.resultStatus })
    .from(competitionResults)
    .where(eq(competitionResults.registrationId, registrationId))
    .limit(1);

  if (existing?.resultStatus === "published") {
    throw new ResultError(
      "result_already_published",
      409,
      "Result is already published — unpublish before editing",
    );
  }

  const now = new Date();
  const [row] = await db
    .insert(competitionResults)
    .values({
      registrationId,
      competitionId,
      resultStatus: "draft",
      resultLabel: input.resultLabel ?? null,
      resultNotes: input.resultNotes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: competitionResults.registrationId,
      set: {
        resultLabel: input.resultLabel ?? null,
        resultNotes: input.resultNotes ?? null,
        updatedAt: now,
      },
    })
    .returning();

  return row!;
};

/**
 * Transition result draft → published for a registration.
 * Validates result_label is non-null/non-blank before commit.
 * For team registrations, bulk-updates all member rows under team_id + competition_id
 * in the same transaction.
 * Writes a result_published audit log entry inside the same transaction (5.4 / 5.3-D4).
 * Returns the updated result row for the given registrationId.
 */
export const publishResult = async (
  institutionId: string,
  competitionId: string,
  registrationId: string,
  actorMembershipId: string,
  db: Database = getDb(),
): Promise<{ result: ResultInstitutionView; teamId: string | null; publishedAt: Date }> => {
  if (!(await ownsCompetition(institutionId, competitionId, db))) {
    throw new ResultError("result_registration_not_found", 404, "Registration not found");
  }

  const meta = await loadRegistrationMeta(competitionId, registrationId, db);
  if (!meta) {
    throw new ResultError("result_registration_not_found", 404, "Registration not found");
  }

  // `now` is the publish-event timestamp written to every member row's published_at. It is also
  // returned so the caller can fold it into the result.published idempotency key — each genuine
  // publish (including an unpublish→republish) is then a distinct BullMQ job that fires, while a
  // true double-enqueue of the SAME publish event still dedups on the identical timestamp.
  const now = new Date();

  const updatedRows = await db.transaction(async (tx) => {
    // Label check inside the transaction: prevents a concurrent null-label upsert
    // from producing a published row between the check and the UPDATE commit.
    const [existing] = await tx
      .select({
        resultLabel: competitionResults.resultLabel,
        resultNotes: competitionResults.resultNotes,
      })
      .from(competitionResults)
      .where(eq(competitionResults.registrationId, registrationId))
      .limit(1);

    if (!existing || !existing.resultLabel?.trim()) {
      throw new ResultError(
        "result_label_required",
        422,
        "result_label must be non-blank before publishing",
      );
    }

    let rows;
    if (meta.teamId) {
      // Fetch all team member registration IDs, then upsert a published result row
      // for each — this creates rows for members who have no result row yet
      // (only the captain's registration has a draft row from upsertResultDraft).
      const memberRegs = await tx
        .select({ id: competitionRegistrations.id })
        .from(competitionRegistrations)
        .where(
          and(
            eq(competitionRegistrations.teamId, meta.teamId),
            eq(competitionRegistrations.competitionId, competitionId),
          ),
        );

      rows = await tx
        .insert(competitionResults)
        .values(
          memberRegs.map((r) => ({
            registrationId: r.id,
            competitionId,
            resultStatus: "published" as const,
            resultLabel: existing.resultLabel,
            resultNotes: existing.resultNotes,
            publishedAt: now,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: competitionResults.registrationId,
          set: {
            resultStatus: "published" as const,
            resultLabel: existing.resultLabel,
            resultNotes: existing.resultNotes,
            publishedAt: now,
            updatedAt: now,
          },
        })
        .returning();
    } else {
      rows = await tx
        .update(competitionResults)
        .set({ resultStatus: "published", publishedAt: now, updatedAt: now })
        .where(
          and(
            eq(competitionResults.registrationId, registrationId),
            eq(competitionResults.competitionId, competitionId),
          ),
        )
        .returning();
    }

    await tx.insert(institutionAuditLogs).values({
      institutionId,
      targetMembershipId: actorMembershipId,
      action: "result_published",
      metadata: {
        competitionId,
        registrationId,
        resultLabel: existing.resultLabel,
        registrationType: meta.registrationType,
        ...(meta.teamId ? { teamId: meta.teamId } : {}),
      },
    });

    return rows;
  });

  const row = updatedRows.find((r) => r.registrationId === registrationId) ?? updatedRows[0];
  if (!row) {
    throw new ResultError("result_registration_not_found", 404, "Registration not found");
  }

  return { result: row, teamId: meta.teamId, publishedAt: now };
};

/**
 * Transition result published → draft for a registration.
 * Nulls published_at. Mirrors publishResult's team bulk-update pattern.
 * Writes a result_unpublished audit log entry inside the same transaction (5.4 / 5.3-D4).
 */
export const unpublishResult = async (
  institutionId: string,
  competitionId: string,
  registrationId: string,
  actorMembershipId: string,
  db: Database = getDb(),
): Promise<ResultInstitutionView> => {
  if (!(await ownsCompetition(institutionId, competitionId, db))) {
    throw new ResultError("result_registration_not_found", 404, "Registration not found");
  }

  const meta = await loadRegistrationMeta(competitionId, registrationId, db);
  if (!meta) {
    throw new ResultError("result_registration_not_found", 404, "Registration not found");
  }

  const now = new Date();

  const updatedRows = await db.transaction(async (tx) => {
    let rows;
    if (meta.teamId) {
      rows = await tx
        .update(competitionResults)
        .set({ resultStatus: "draft", publishedAt: null, updatedAt: now })
        .where(
          and(
            eq(competitionResults.competitionId, competitionId),
            sql`${competitionResults.registrationId} IN (
              SELECT id FROM competition_registrations
              WHERE team_id = ${meta.teamId} AND competition_id = ${competitionId}
            )`,
          ),
        )
        .returning();
    } else {
      rows = await tx
        .update(competitionResults)
        .set({ resultStatus: "draft", publishedAt: null, updatedAt: now })
        .where(
          and(
            eq(competitionResults.registrationId, registrationId),
            eq(competitionResults.competitionId, competitionId),
          ),
        )
        .returning();
    }

    await tx.insert(institutionAuditLogs).values({
      institutionId,
      targetMembershipId: actorMembershipId,
      action: "result_unpublished",
      metadata: { competitionId, registrationId },
    });

    return rows;
  });

  const row = updatedRows.find((r) => r.registrationId === registrationId) ?? updatedRows[0];
  if (!row) {
    throw new ResultError("result_registration_not_found", 404, "Registration not found");
  }

  return row;
};

/**
 * Candidate-scoped result read. Returns result_label and result_notes only when the
 * result is published and belongs to the requesting candidate. Returns null when
 * absent, unpublished, or the registration does not belong to the candidate (caller
 * converts to 404 — no information leak).
 */
export const getPublishedResultForCandidate = async (
  candidateUserId: string,
  competitionId: string,
  registrationId: string,
  db: Database = getDb(),
): Promise<ResultCandidateView | null> => {
  // Confirm the registration belongs to the candidate before reading result.
  const [reg] = await db
    .select({ studentId: competitionRegistrations.studentId })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.id, registrationId),
        eq(competitionRegistrations.competitionId, competitionId),
      ),
    )
    .limit(1);

  // IDOR: missing, wrong competition, or wrong owner all collapse to null.
  if (!reg || reg.studentId !== candidateUserId) return null;

  // Filter by published status in the WHERE clause so result_status is not projected
  // into the result shape — only result_label and result_notes reach the candidate.
  const [result] = await db
    .select({
      resultLabel: competitionResults.resultLabel,
      resultNotes: competitionResults.resultNotes,
    })
    .from(competitionResults)
    .where(
      and(
        eq(competitionResults.registrationId, registrationId),
        eq(competitionResults.resultStatus, "published"),
      ),
    )
    .limit(1);

  if (!result || !result.resultLabel) return null;

  return {
    resultLabel: result.resultLabel,
    resultNotes: result.resultNotes,
  };
};

export type CandidatePublishedResultSummary = {
  registrationId: string;
  competitionId: string;
  competitionTitle: string;
  competitionSlug: string;
  institutionSlug: string;
  resultLabel: string;
  resultNotes: string | null;
  publishedAt: Date;
};

/**
 * List all published results for a candidate across all their registrations.
 * Used for the candidate result listing page. Only confirmed registrations are included.
 */
export const listCandidatePublishedResults = async (
  candidateUserId: string,
  db: Database = getDb(),
): Promise<CandidatePublishedResultSummary[]> => {
  const rows = await db
    .select({
      registrationId: competitionRegistrations.id,
      competitionId: competitions.id,
      competitionTitle: competitions.title,
      competitionSlug: competitions.slug,
      institutionSlug: institutions.slug,
      resultLabel: competitionResults.resultLabel,
      resultNotes: competitionResults.resultNotes,
      publishedAt: competitionResults.publishedAt,
    })
    .from(competitionRegistrations)
    .innerJoin(
      competitionResults,
      eq(competitionResults.registrationId, competitionRegistrations.id),
    )
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitionRegistrations.studentId, candidateUserId),
        eq(competitionResults.resultStatus, "published"),
        isNotNull(competitionResults.publishedAt),
        isNotNull(competitionResults.resultLabel),
      ),
    );

  return rows
    .filter((r) => r.resultLabel !== null && r.publishedAt !== null)
    .map((r) => ({
      registrationId: r.registrationId,
      competitionId: r.competitionId,
      competitionTitle: r.competitionTitle,
      competitionSlug: r.competitionSlug,
      institutionSlug: r.institutionSlug,
      resultLabel: r.resultLabel!,
      resultNotes: r.resultNotes,
      publishedAt: r.publishedAt!,
    }));
};
