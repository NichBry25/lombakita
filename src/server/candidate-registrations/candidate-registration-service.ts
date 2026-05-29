import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/candidate-registrations/candidate-registration-service");

// Step 4.5 — Read-only services for the candidate participation dashboard.
// Depends on competition_registrations rows produced by Step 4.2 (individual) and Step 4.4 (team).
// No mutations. userId must always be session.user.id — callers enforce authorization.

import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  institutions,
  teams,
  type CompetitionMode,
} from "@/server/db/schema";

export type IndividualRegistrationSummary = {
  id: string;
  competitionId: string;
  registrationStatus: "confirmed" | "cancelled" | "pending_payment";
  registeredAt: Date;
  cancelledAt: Date | null;
  createdAt: Date;
  competitionTitle: string;
  competitionSlug: string;
  competitionMode: CompetitionMode | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  eventEndAt: Date | null;
  institutionSlug: string;
};

export type TeamRegistrationSummary = IndividualRegistrationSummary & {
  teamId: string;
  teamName: string;
  teamStatus: "forming" | "submitted" | "cancelled";
  isCaptain: boolean;
};

const INDIVIDUAL_COLUMNS = {
  id: competitionRegistrations.id,
  competitionId: competitionRegistrations.competitionId,
  registrationStatus: competitionRegistrations.status,
  registeredAt: competitionRegistrations.registeredAt,
  cancelledAt: competitionRegistrations.cancelledAt,
  createdAt: competitionRegistrations.createdAt,
  competitionTitle: competitions.title,
  competitionSlug: competitions.slug,
  competitionMode: competitions.mode,
  registrationEndAt: competitions.registrationEndAt,
  eventStartAt: competitions.eventStartAt,
  eventEndAt: competitions.eventEndAt,
  institutionSlug: institutions.slug,
} as const;

const TEAM_COLUMNS = {
  id: competitionRegistrations.id,
  competitionId: competitionRegistrations.competitionId,
  registrationStatus: competitionRegistrations.status,
  registeredAt: competitionRegistrations.registeredAt,
  cancelledAt: competitionRegistrations.cancelledAt,
  createdAt: competitionRegistrations.createdAt,
  competitionTitle: competitions.title,
  competitionSlug: competitions.slug,
  competitionMode: competitions.mode,
  registrationEndAt: competitions.registrationEndAt,
  eventStartAt: competitions.eventStartAt,
  eventEndAt: competitions.eventEndAt,
  institutionSlug: institutions.slug,
  teamId: competitionRegistrations.teamId,
  teamName: teams.name,
  teamStatus: teams.status,
  captainId: teams.captainId,
} as const;

// Returns all individual registrations for a candidate (all statuses, newest first, limit 10).
// Soft-deleted competitions are excluded. Callers must pass session.user.id as userId.
export const listCandidateIndividualRegistrations = async (
  userId: string,
  db: Database = getDb(),
): Promise<IndividualRegistrationSummary[]> => {
  const rows = await db
    .select(INDIVIDUAL_COLUMNS)
    .from(competitionRegistrations)
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitionRegistrations.studentId, userId),
        eq(competitionRegistrations.registrationType, "individual"),
        isNull(competitions.deletedAt),
      ),
    )
    .orderBy(desc(competitionRegistrations.createdAt))
    .limit(10);

  return rows as unknown as IndividualRegistrationSummary[];
};

// Returns all team registrations for a candidate (all statuses, newest first, limit 10).
// isCaptain is derived by comparing teams.captainId against userId — no additional query.
// Soft-deleted competitions are excluded. Callers must pass session.user.id as userId.
export const listCandidateTeamRegistrations = async (
  userId: string,
  db: Database = getDb(),
): Promise<TeamRegistrationSummary[]> => {
  const rows = await db
    .select(TEAM_COLUMNS)
    .from(competitionRegistrations)
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .innerJoin(teams, eq(teams.id, competitionRegistrations.teamId!))
    .where(
      and(
        eq(competitionRegistrations.studentId, userId),
        eq(competitionRegistrations.registrationType, "team"),
        isNull(competitions.deletedAt),
      ),
    )
    .orderBy(desc(competitionRegistrations.createdAt))
    .limit(10);

  return rows.map((row) => ({
    id: row.id,
    competitionId: row.competitionId,
    registrationStatus: row.registrationStatus,
    registeredAt: row.registeredAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    competitionTitle: row.competitionTitle,
    competitionSlug: row.competitionSlug,
    competitionMode: row.competitionMode,
    registrationEndAt: row.registrationEndAt,
    eventStartAt: row.eventStartAt,
    eventEndAt: row.eventEndAt,
    institutionSlug: row.institutionSlug,
    teamId: row.teamId as string,
    teamName: row.teamName,
    teamStatus: row.teamStatus,
    isCaptain: row.captainId === userId,
  }));
};
