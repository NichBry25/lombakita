// CSV export service for institution competition data (Step 5.4).
//
// Three export functions: registrants, submissions, results. Each validates institution
// ownership of the competition at the service layer before querying — ownership failure
// throws ExportOwnershipError (caller maps to 404, no info leak). On success, returns a
// UTF-8 BOM-prefixed CSV string ready for streaming as text/csv.
//
// Manual CSV construction: no library dependency. Cells containing comma, double-quote,
// or newline are wrapped in double-quotes; internal double-quotes are doubled (RFC 4180).

import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  competitionRegistrations,
  competitionResults,
  competitionSubmissions,
  teams,
  userProfiles,
  users,
} from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/participants/export-service");

// UTF-8 BOM for Excel compatibility.
export const CSV_BOM = "﻿";

export class ExportOwnershipError extends Error {
  constructor(message = "Competition not found or access denied") {
    super(message);
    this.name = "ExportOwnershipError";
  }
}

// Wrap a cell value in double-quotes when it contains a comma, double-quote, or newline.
// Internal double-quotes are doubled. Null/undefined coerced to empty string.
export const escapeCell = (val: string | number | boolean | null | undefined | Date): string => {
  const str = val == null ? "" : val instanceof Date ? val.toISOString() : String(val);
  if (/[,"\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const buildRow = (cells: (string | number | boolean | null | undefined | Date)[]): string =>
  cells.map(escapeCell).join(",");

const ownsCompetition = async (
  institutionId: string,
  competitionId: string,
  db: Database,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: competitions.id })
    .from(competitions)
    .where(and(eq(competitions.id, competitionId), eq(competitions.institutionId, institutionId)))
    .limit(1);
  return Boolean(row);
};

// ─── Registrants export ──────────────────────────────────────────────────────
//
// Columns: registration_id, registration_type, team_name, is_captain,
//          participant_name, participant_email, registration_status,
//          internal_review_status, has_submission, submission_finalized, registered_at
//
// Includes all statuses (confirmed + cancelled). Each team member gets their own row.
// internal_notes is intentionally excluded.

export const exportRegistrantsAsCsv = async (
  institutionId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<string> => {
  if (!(await ownsCompetition(institutionId, competitionId, db))) {
    throw new ExportOwnershipError();
  }

  const participantUser = alias(users, "participant_user");
  const participantProfile = alias(userProfiles, "participant_profile");

  const rows = await db
    .select({
      registrationId: competitionRegistrations.id,
      registrationType: competitionRegistrations.registrationType,
      teamId: competitionRegistrations.teamId,
      studentId: competitionRegistrations.studentId,
      registrationStatus: competitionRegistrations.status,
      internalReviewStatus: competitionRegistrations.internalReviewStatus,
      registeredAt: competitionRegistrations.registeredAt,
      teamName: teams.name,
      captainId: teams.captainId,
      participantName: participantProfile.displayName,
      participantUsername: participantUser.username,
      participantEmail: participantUser.email,
      submissionRegistrationId: competitionSubmissions.registrationId,
      submissionFinalizedAt: competitionSubmissions.finalizedAt,
    })
    .from(competitionRegistrations)
    .leftJoin(teams, eq(teams.id, competitionRegistrations.teamId))
    .innerJoin(participantUser, eq(participantUser.id, competitionRegistrations.studentId))
    .leftJoin(participantProfile, eq(participantProfile.userId, participantUser.id))
    .leftJoin(
      competitionSubmissions,
      eq(competitionSubmissions.registrationId, competitionRegistrations.id),
    )
    .where(eq(competitionRegistrations.competitionId, competitionId))
    .orderBy(competitionRegistrations.registeredAt);

  const header = buildRow([
    "registration_id",
    "registration_type",
    "team_name",
    "is_captain",
    "participant_name",
    "participant_email",
    "registration_status",
    "internal_review_status",
    "has_submission",
    "submission_finalized",
    "registered_at",
  ]);

  const dataRows = rows.map((r) => {
    const name = r.participantName ?? r.participantUsername ?? "";
    const isCaptain =
      r.registrationType === "team" && r.teamId != null ? r.studentId === r.captainId : null;
    const hasSubmission = r.submissionRegistrationId != null;
    const finalized = hasSubmission ? r.submissionFinalizedAt != null : null;

    return buildRow([
      r.registrationId,
      r.registrationType,
      r.teamName ?? "",
      isCaptain == null ? "" : isCaptain ? "true" : "false",
      name,
      r.participantEmail,
      r.registrationStatus,
      r.internalReviewStatus,
      hasSubmission ? "true" : "false",
      finalized == null ? "" : finalized ? "true" : "false",
      r.registeredAt,
    ]);
  });

  const csv = CSV_BOM + [header, ...dataRows].join("\n");
  logger.info("export.registrants", { competitionId, rowCount: dataRows.length });
  return csv;
};

// ─── Submissions export ───────────────────────────────────────────────────────
//
// Columns: registration_id, participant_name, file_name, file_size_bytes,
//          version, finalized, submitted_at
//
// Includes all submissions regardless of finalization status.

export const exportSubmissionsAsCsv = async (
  institutionId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<string> => {
  if (!(await ownsCompetition(institutionId, competitionId, db))) {
    throw new ExportOwnershipError();
  }

  const participantUser = alias(users, "participant_user");
  const participantProfile = alias(userProfiles, "participant_profile");

  const rows = await db
    .select({
      registrationId: competitionSubmissions.registrationId,
      participantName: participantProfile.displayName,
      participantUsername: participantUser.username,
      fileName: competitionSubmissions.fileName,
      fileSizeBytes: competitionSubmissions.fileSizeBytes,
      version: competitionSubmissions.version,
      finalizedAt: competitionSubmissions.finalizedAt,
      submittedAt: competitionSubmissions.submittedAt,
    })
    .from(competitionSubmissions)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionSubmissions.registrationId),
    )
    .innerJoin(participantUser, eq(participantUser.id, competitionRegistrations.studentId))
    .leftJoin(participantProfile, eq(participantProfile.userId, participantUser.id))
    .where(eq(competitionRegistrations.competitionId, competitionId))
    .orderBy(competitionSubmissions.submittedAt);

  const header = buildRow([
    "registration_id",
    "participant_name",
    "file_name",
    "file_size_bytes",
    "version",
    "finalized",
    "submitted_at",
  ]);

  const dataRows = rows.map((r) =>
    buildRow([
      r.registrationId,
      r.participantName ?? r.participantUsername ?? "",
      r.fileName,
      r.fileSizeBytes ?? "",
      r.version,
      r.finalizedAt != null ? "true" : "false",
      r.submittedAt,
    ]),
  );

  const csv = CSV_BOM + [header, ...dataRows].join("\n");
  logger.info("export.submissions", { competitionId, rowCount: dataRows.length });
  return csv;
};

// ─── Results export ───────────────────────────────────────────────────────────
//
// Columns: registration_id, participant_name, team_name, result_label,
//          result_notes, result_status, published_at
//
// Includes both draft and published results (status column distinguishes them).

export const exportResultsAsCsv = async (
  institutionId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<string> => {
  if (!(await ownsCompetition(institutionId, competitionId, db))) {
    throw new ExportOwnershipError();
  }

  const participantUser = alias(users, "participant_user");
  const participantProfile = alias(userProfiles, "participant_profile");

  const rows = await db
    .select({
      registrationId: competitionResults.registrationId,
      participantName: participantProfile.displayName,
      participantUsername: participantUser.username,
      teamName: teams.name,
      resultLabel: competitionResults.resultLabel,
      resultNotes: competitionResults.resultNotes,
      resultStatus: competitionResults.resultStatus,
      publishedAt: competitionResults.publishedAt,
    })
    .from(competitionResults)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionResults.registrationId),
    )
    .innerJoin(participantUser, eq(participantUser.id, competitionRegistrations.studentId))
    .leftJoin(participantProfile, eq(participantProfile.userId, participantUser.id))
    .leftJoin(teams, eq(teams.id, competitionRegistrations.teamId))
    .where(eq(competitionResults.competitionId, competitionId))
    .orderBy(competitionResults.publishedAt);

  const header = buildRow([
    "registration_id",
    "participant_name",
    "team_name",
    "result_label",
    "result_notes",
    "result_status",
    "published_at",
  ]);

  const dataRows = rows.map((r) =>
    buildRow([
      r.registrationId,
      r.participantName ?? r.participantUsername ?? "",
      r.teamName ?? "",
      r.resultLabel ?? "",
      r.resultNotes ?? "",
      r.resultStatus,
      r.publishedAt ?? "",
    ]),
  );

  const csv = CSV_BOM + [header, ...dataRows].join("\n");
  logger.info("export.results", { competitionId, rowCount: dataRows.length });
  return csv;
};
