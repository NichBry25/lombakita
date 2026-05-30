// Reads across three table groups:
//   1. competitions + competitionRegistrations — main data and institution ownership verification
//   2. teams + teamMemberships + users + userProfiles — participant identity and team info
//   3. competitionSubmissions — submission presence and finalization state
// Access invariant: competitions.institution_id must equal institutionId before any data is returned.
// Cross-institution competitionId (IDOR) collapses to an empty result — same no-leak pattern as
// assertCompetitionInInstitution in competition-service.ts.

import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  competitionRegistrations,
  competitionSubmissions,
  teams,
  teamMemberships,
  userProfiles,
  users,
} from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/participants/participant-service");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const resolvePage = (raw: number | undefined): number => {
  if (!raw || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
};

const resolveLimit = (raw: number | undefined): number => {
  if (!raw || !Number.isFinite(raw) || raw < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(raw, MAX_PAGE_SIZE);
};

export type SubmissionView = {
  exists: boolean;
  finalized: boolean;
  submittedAt: string | null;
  finalizedAt: string | null;
};

export type ParticipantRecord = {
  registrationId: string;
  registrationType: "individual" | "team";
  status: "confirmed" | "cancelled" | "pending_payment";
  registeredAt: string;
  candidate: { userId: string; displayName: string | null; username: string } | null;
  team: {
    teamId: string;
    teamName: string;
    captainDisplayName: string | null;
    activeMemberCount: number;
  } | null;
  submission: SubmissionView | null;
};

export type ParticipantListFilters = {
  status?: "all" | "confirmed" | "cancelled";
  type?: "all" | "individual" | "team";
  page?: number;
  limit?: number;
};

export type ParticipantCounts = {
  total: number;
  confirmed: number;
  pending: number;
  cancelled: number;
  withSubmissions: number;
  withFinalizedSubmissions: number;
};

export type ParticipantListResult = {
  participants: ParticipantRecord[];
  pagination: { page: number; limit: number; totalPages: number; totalCount: number };
  counts: ParticipantCounts;
};

const toISOOrNull = (val: Date | string | null | undefined): string | null => {
  if (val == null) return null;
  return val instanceof Date ? val.toISOString() : String(val);
};

const toISO = (val: Date | string | null | undefined): string =>
  val instanceof Date ? val.toISOString() : String(val ?? "");

const EMPTY_COUNTS: ParticipantCounts = {
  total: 0,
  confirmed: 0,
  pending: 0,
  cancelled: 0,
  withSubmissions: 0,
  withFinalizedSubmissions: 0,
};

const EMPTY_RESULT: ParticipantListResult = {
  participants: [],
  pagination: { page: 1, limit: DEFAULT_PAGE_SIZE, totalPages: 0, totalCount: 0 },
  counts: EMPTY_COUNTS,
};

export const listCompetitionParticipants = async (
  institutionId: string,
  competitionId: string,
  filters: ParticipantListFilters,
  db: Database = getDb(),
): Promise<ParticipantListResult> => {
  // Ownership check: collapse to empty result on mismatch (no info leak).
  const [comp] = await db
    .select({ id: competitions.id })
    .from(competitions)
    .where(
      and(eq(competitions.id, competitionId), eq(competitions.institutionId, institutionId)),
    )
    .limit(1);

  if (!comp) return EMPTY_RESULT;

  const page = resolvePage(filters.page);
  const limit = resolveLimit(filters.limit);
  const offset = (page - 1) * limit;

  // Build filtered WHERE for the paginated query.
  const conditions: SQL[] = [eq(competitionRegistrations.competitionId, competitionId)];
  if (filters.status && filters.status !== "all") {
    conditions.push(eq(competitionRegistrations.status, filters.status));
  }
  if (filters.type && filters.type !== "all") {
    conditions.push(eq(competitionRegistrations.registrationType, filters.type));
  }
  const whereClause = and(...conditions)!;

  // Aliases for the two user + profile joins (candidate and captain).
  const candidateUser = alias(users, "candidate_user");
  const candidateProfile = alias(userProfiles, "candidate_profile");
  const captainUser = alias(users, "captain_user");
  const captainProfile = alias(userProfiles, "captain_profile");

  // Run paginated data + aggregate counts in parallel.
  // Inner async IIFE creates chain for page data (call #1) then page count (call #2) synchronously
  // before yielding. The outer Promise.all's second argument creates the aggregate counts chain
  // (call #3) after the IIFE has started. Batch team member count runs after (call #4 if needed).
  const [pageResult, countsRows] = await Promise.all([
    (async () => {
      const [dataRows, countRows] = await Promise.all([
        db
          .select({
            registrationId: competitionRegistrations.id,
            registrationType: competitionRegistrations.registrationType,
            status: competitionRegistrations.status,
            registeredAt: competitionRegistrations.registeredAt,
            teamId: competitionRegistrations.teamId,
            candidateUserId: candidateUser.id,
            candidateDisplayName: candidateProfile.displayName,
            candidateUsername: candidateUser.username,
            teamName: teams.name,
            captainDisplayName: captainProfile.displayName,
            submissionRegistrationId: competitionSubmissions.registrationId,
            submissionFinalizedAt: competitionSubmissions.finalizedAt,
            submissionSubmittedAt: competitionSubmissions.submittedAt,
          })
          .from(competitionRegistrations)
          .leftJoin(candidateUser, eq(candidateUser.id, competitionRegistrations.studentId))
          .leftJoin(candidateProfile, eq(candidateProfile.userId, candidateUser.id))
          .leftJoin(teams, eq(teams.id, competitionRegistrations.teamId))
          .leftJoin(captainUser, eq(captainUser.id, teams.captainId))
          .leftJoin(captainProfile, eq(captainProfile.userId, captainUser.id))
          .leftJoin(
            competitionSubmissions,
            eq(competitionSubmissions.registrationId, competitionRegistrations.id),
          )
          .where(whereClause)
          .orderBy(desc(competitionRegistrations.registeredAt))
          .limit(limit)
          .offset(offset),

        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(competitionRegistrations)
          .where(whereClause),
      ]);
      return { dataRows, totalCount: dataRows.length > 0 ? (countRows[0]?.count ?? 0) : 0 };
    })(),

    // Aggregate counts — always full competition, no filter params applied.
    db
      .select({
        total: sql<number>`COUNT(*)::int`,
        confirmed: sql<number>`COUNT(*) FILTER (WHERE ${competitionRegistrations.status} = 'confirmed')::int`,
        pending: sql<number>`COUNT(*) FILTER (WHERE ${competitionRegistrations.status} = 'pending_payment')::int`,
        cancelled: sql<number>`COUNT(*) FILTER (WHERE ${competitionRegistrations.status} = 'cancelled')::int`,
        withSubmissions: sql<number>`COUNT(DISTINCT ${competitionSubmissions.registrationId})::int`,
        withFinalizedSubmissions: sql<number>`COUNT(DISTINCT CASE WHEN ${competitionSubmissions.finalizedAt} IS NOT NULL THEN ${competitionSubmissions.registrationId} END)::int`,
      })
      .from(competitionRegistrations)
      .leftJoin(
        competitionSubmissions,
        eq(competitionSubmissions.registrationId, competitionRegistrations.id),
      )
      .where(eq(competitionRegistrations.competitionId, competitionId)),
  ]);

  const { dataRows, totalCount } = pageResult;
  const countsRow = countsRows[0];

  // Batch-fetch active team member counts — one query for all team_id values on this page.
  const teamIds = dataRows
    .filter((r) => r.registrationType === "team" && r.teamId != null)
    .map((r) => r.teamId as string);

  const memberCountMap = new Map<string, number>();
  if (teamIds.length > 0) {
    const memberCounts = await db
      .select({
        teamId: teamMemberships.teamId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(teamMemberships)
      .where(
        and(inArray(teamMemberships.teamId, teamIds), eq(teamMemberships.status, "active")),
      )
      .groupBy(teamMemberships.teamId);
    for (const row of memberCounts) {
      memberCountMap.set(row.teamId, row.count ?? 0);
    }
  }

  // Map raw DB rows to the ParticipantRecord shape.
  const participants: ParticipantRecord[] = dataRows.map((row) => {
    const submission: SubmissionView | null =
      row.submissionRegistrationId != null
        ? {
            exists: true,
            finalized: row.submissionFinalizedAt != null,
            submittedAt: toISOOrNull(row.submissionSubmittedAt),
            finalizedAt: toISOOrNull(row.submissionFinalizedAt),
          }
        : null;

    if (row.registrationType === "team") {
      return {
        registrationId: row.registrationId,
        registrationType: "team",
        status: row.status,
        registeredAt: toISO(row.registeredAt),
        candidate: null,
        team: {
          teamId: row.teamId!,
          teamName: row.teamName ?? "",
          captainDisplayName: row.captainDisplayName ?? null,
          activeMemberCount: memberCountMap.get(row.teamId!) ?? 0,
        },
        submission,
      };
    }

    return {
      registrationId: row.registrationId,
      registrationType: "individual",
      status: row.status,
      registeredAt: toISO(row.registeredAt),
      candidate: {
        userId: row.candidateUserId ?? "",
        displayName: row.candidateDisplayName ?? null,
        username: row.candidateUsername ?? "",
      },
      team: null,
      submission,
    };
  });

  const totalCountNum = Number(totalCount ?? 0);

  return {
    participants,
    pagination: {
      page,
      limit,
      totalPages: totalCountNum > 0 ? Math.ceil(totalCountNum / limit) : 0,
      totalCount: totalCountNum,
    },
    counts: {
      total: countsRow?.total ?? 0,
      confirmed: countsRow?.confirmed ?? 0,
      pending: countsRow?.pending ?? 0,
      cancelled: countsRow?.cancelled ?? 0,
      withSubmissions: countsRow?.withSubmissions ?? 0,
      withFinalizedSubmissions: countsRow?.withFinalizedSubmissions ?? 0,
    },
  };
};
