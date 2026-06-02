import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-registration-service");

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import {
  enqueueRegistrationConfirmed,
  enqueueRegistrationCancelled,
} from "@/server/async/enqueue";
import {
  competitionRegistrations,
  competitions,
  teamMemberships,
  teams,
  type CompetitionRegistrationStatus,
} from "@/server/db/schema";
import { checkStudentEligibility } from "@/server/eligibility/eligibility-service";
import { TeamError } from "@/server/teams/team-core";

// Postgres error code extraction — mirrors the pattern used in team-service.ts. Drizzle wraps
// the underlying pg error in a DrizzleQueryError; read both shapes (direct + cause).
const pgErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause === "object" && typeof cause.code === "string") return cause.code;
  return undefined;
};

type CompetitionSnapshot = {
  id: string;
  status: "draft" | "published" | "archived";
  mode: "individual" | "team" | "both" | null;
  minTeamSize: number | null;
  maxTeamSize: number | null;
  registrationStartAt: Date | null;
  registrationEndAt: Date | null;
};

type TeamSnapshot = {
  id: string;
  competitionId: string;
  captainId: string;
  status: "forming" | "submitted" | "cancelled";
};

type TeamRegistrationResult = {
  teamId: string;
  status: "submitted" | "forming";
  registrations: { id: string; studentId: string; status: CompetitionRegistrationStatus }[];
};

const loadTeam = async (teamId: string, db: Database): Promise<TeamSnapshot | null> => {
  const [row] = await db
    .select({
      id: teams.id,
      competitionId: teams.competitionId,
      captainId: teams.captainId,
      status: teams.status,
    })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  return row ?? null;
};

const loadCompetition = async (
  competitionId: string,
  db: Database,
): Promise<CompetitionSnapshot | null> => {
  const [row] = await db
    .select({
      id: competitions.id,
      status: competitions.status,
      mode: competitions.mode,
      minTeamSize: competitions.minTeamSize,
      maxTeamSize: competitions.maxTeamSize,
      registrationStartAt: competitions.registrationStartAt,
      registrationEndAt: competitions.registrationEndAt,
    })
    .from(competitions)
    .where(and(eq(competitions.id, competitionId), isNull(competitions.deletedAt)))
    .limit(1);
  return row ?? null;
};

const loadActiveMemberUserIds = async (
  teamId: string,
  db: Database,
): Promise<{ membershipId: string; userId: string }[]> => {
  return db
    .select({ membershipId: teamMemberships.id, userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(
      and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")),
    );
};

// Assert that the caller is the active captain of this team and that the team belongs to the
// URL competitionId. A teamId/competitionId mismatch returns 404 — never 403 — so attackers
// cannot probe team ownership across competitions by URL forging.
const assertCaptainAccess = (
  team: TeamSnapshot,
  competitionId: string,
  callerUserId: string,
): void => {
  if (team.competitionId !== competitionId) {
    throw new TeamError("team_not_found", "Team not found");
  }
  if (team.captainId !== callerUserId) {
    throw new TeamError("team_not_captain", "Only the team captain may perform this action");
  }
};

// Step 4.4 — Captain submits the team for the given competition. Pre-transaction guards run in
// the order documented in the implementation prompt. The actual writes happen inside a single
// transaction with a TOCTOU backstop on the team status update.
export const submitTeamRegistration = async (
  callerUserId: string,
  competitionId: string,
  teamId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<TeamRegistrationResult> => {
  // (a) team exists and belongs to the URL competition; caller is the captain.
  const team = await loadTeam(teamId, db);
  if (!team) {
    throw new TeamError("team_not_found", "Team not found");
  }
  assertCaptainAccess(team, competitionId, callerUserId);

  // (b) team is in forming state.
  if (team.status !== "forming") {
    throw new TeamError("team_not_forming", "Team is no longer in forming state", {
      currentStatus: team.status,
    });
  }

  // (c) competition exists and is published.
  const competition = await loadCompetition(competitionId, db);
  if (!competition) {
    throw new TeamError("team_competition_not_found", "Competition not found");
  }
  if (competition.status !== "published") {
    throw new TeamError(
      "team_competition_not_published",
      "Competition is not open for registration",
    );
  }

  // (d) competition accepts team registration.
  if (competition.mode === "individual") {
    throw new TeamError(
      "team_registration_not_allowed",
      "This competition does not accept team registration",
    );
  }

  // (e) registration window open. Both bounds enforced; if start is null the window is treated
  // as immediately open (matches the individual-registration helper which only enforces end).
  if (
    competition.registrationStartAt &&
    competition.registrationStartAt.getTime() > now.getTime()
  ) {
    throw new TeamError(
      "registration_not_yet_open",
      "Registration window has not yet opened",
    );
  }
  if (
    !competition.registrationEndAt ||
    competition.registrationEndAt.getTime() <= now.getTime()
  ) {
    throw new TeamError("registration_window_closed", "Registration window has closed");
  }

  // (f) load active members. Must include the captain — captain has an active membership row
  // by construction of createTeam.
  const members = await loadActiveMemberUserIds(teamId, db);
  const memberCount = members.length;

  // (g) team size bounds. Both bounds optional; only enforced when set on the competition.
  if (competition.minTeamSize !== null && memberCount < competition.minTeamSize) {
    throw new TeamError(
      "team_size_insufficient",
      `Team has ${memberCount} active member(s); minimum is ${competition.minTeamSize}`,
      { activeMemberCount: memberCount, minTeamSize: competition.minTeamSize },
    );
  }
  if (competition.maxTeamSize !== null && memberCount > competition.maxTeamSize) {
    throw new TeamError(
      "team_size_exceeded",
      `Team has ${memberCount} active member(s); maximum is ${competition.maxTeamSize}`,
      { activeMemberCount: memberCount, maxTeamSize: competition.maxTeamSize },
    );
  }

  // (h) per-member eligibility. Run sequentially against the helper — each call is one DB read,
  // and team rosters in MVP are small. Collect all ineligible members instead of fail-fast so
  // the captain can see the full list at once.
  const memberUserIds = members.map((m) => m.userId);
  const ineligible: { userId: string; status: string; reasons: string[] }[] = [];
  for (const userId of memberUserIds) {
    const result = await checkStudentEligibility(userId, db);
    if (result.status !== "eligible") {
      ineligible.push({ userId, status: result.status, reasons: result.reasons });
    }
  }
  if (ineligible.length > 0) {
    throw new TeamError(
      "team_member_ineligible",
      `${ineligible.length} team member(s) are not eligible for this competition`,
      { ineligibleMembers: ineligible },
    );
  }

  // (i) pre-check existing non-cancelled registrations for any member. The partial unique
  // index is the safety net; this pre-check produces a clean 409 with the conflicting member
  // ids rather than relying on the index to surface the violation.
  const existingRegs = memberUserIds.length
    ? await db
        .select({
          studentId: competitionRegistrations.studentId,
          status: competitionRegistrations.status,
        })
        .from(competitionRegistrations)
        .where(
          and(
            eq(competitionRegistrations.competitionId, competitionId),
            inArray(competitionRegistrations.studentId, memberUserIds),
          ),
        )
    : [];
  const conflictingMembers = existingRegs
    .filter((r) => r.status !== "cancelled")
    .map((r) => r.studentId);
  if (conflictingMembers.length > 0) {
    throw new TeamError(
      "team_member_already_registered",
      "One or more team members are already registered for this competition",
      { conflictingMembers },
    );
  }

  // Atomic write: insert one registration per active member with type='team', flip the team
  // status to submitted. The team UPDATE WHERE clause re-checks status='forming' (TOCTOU
  // backstop) — zero rows changed means a concurrent disband/submit landed first.
  let submitResult: TeamRegistrationResult;
  try {
    submitResult = await db.transaction(async (tx) => {
      const insertedRows = await tx
        .insert(competitionRegistrations)
        .values(
          memberUserIds.map((userId) => ({
            competitionId,
            studentId: userId,
            teamId,
            registrationType: "team" as const,
            status: "confirmed" as const,
            registeredAt: now,
          })),
        )
        .returning({
          id: competitionRegistrations.id,
          studentId: competitionRegistrations.studentId,
          status: competitionRegistrations.status,
        });

      const teamUpdate = await tx
        .update(teams)
        .set({ status: "submitted", updatedAt: now })
        .where(and(eq(teams.id, teamId), eq(teams.status, "forming")))
        .returning({ id: teams.id });

      if (teamUpdate.length !== 1) {
        // CAS guard: zero rows means the team transitioned out of forming between the read
        // above and this UPDATE. Throwing rolls the inserts back.
        throw new TeamError(
          "team_state_conflict",
          "Team state changed during submission — reload and retry",
        );
      }

      logger.info("team_registration.submitted", {
        teamId,
        competitionId,
        memberCount: memberUserIds.length,
      });

      return {
        teamId,
        status: "submitted" as const,
        registrations: insertedRows,
      };
    });
  } catch (error) {
    if (error instanceof TeamError) throw error;
    const code = pgErrorCode(error);
    // Partial unique index can fire when a member registered as individual between the
    // pre-check and the INSERT. Translate to the same external code.
    if (code === "23505") {
      throw new TeamError(
        "team_member_already_registered",
        "One or more team members are already registered for this competition",
      );
    }
    // CHECK-constraint violation backstop for `competition_registrations_type_team_id_chk`.
    // All current code paths write `registrationType: "team"` + `teamId` atomically, so this
    // is unreachable today. Mirrors the Step 4.3 `team_name_taken` 23505 defense — surfaces
    // a typed 422 instead of a raw 500 if a future regression ever produces a row that
    // violates the type/team_id co-presence invariant.
    if (code === "23514") {
      throw new TeamError(
        "team_registration_invariant_violation",
        "Team registration row violates a database invariant — refresh and retry",
      );
    }
    throw error;
  }

  for (const reg of submitResult.registrations) {
    enqueueRegistrationConfirmed({
      registrationId: reg.id,
      studentId: reg.studentId,
      competitionId,
      registrationType: "team",
    }).catch((err: unknown) => {
      logger.warn("registration.confirmed.enqueue_failed", {
        registrationId: reg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return submitResult;
};

// Step 4.4 — Captain reverts a submitted team back to forming by cancelling every team-typed
// registration row. No deadline check in MVP — captains may cancel a submitted team at any time.
export const cancelTeamRegistration = async (
  callerUserId: string,
  competitionId: string,
  teamId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<TeamRegistrationResult> => {
  const team = await loadTeam(teamId, db);
  if (!team) {
    throw new TeamError("team_not_found", "Team not found");
  }
  assertCaptainAccess(team, competitionId, callerUserId);

  if (team.status !== "submitted") {
    throw new TeamError(
      "team_not_submitted",
      "Team is not in a submitted state and cannot be cancelled",
      { currentStatus: team.status },
    );
  }

  const cancelResult = await db.transaction(async (tx) => {
    const cancelled = await tx
      .update(competitionRegistrations)
      .set({
        status: "cancelled",
        cancelledAt: now,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(competitionRegistrations.teamId, teamId),
          eq(competitionRegistrations.status, "confirmed"),
        ),
      )
      .returning({
        id: competitionRegistrations.id,
        studentId: competitionRegistrations.studentId,
        status: competitionRegistrations.status,
      });

    const teamUpdate = await tx
      .update(teams)
      .set({ status: "forming", updatedAt: now })
      .where(and(eq(teams.id, teamId), eq(teams.status, "submitted")))
      .returning({ id: teams.id });

    if (teamUpdate.length !== 1) {
      throw new TeamError(
        "team_state_conflict",
        "Team state changed during cancellation — reload and retry",
      );
    }

    logger.info("team_registration.cancelled", {
      teamId,
      competitionId,
      cancelledRegistrations: cancelled.length,
    });

    return {
      teamId,
      status: "forming" as const,
      registrations: cancelled,
    };
  });

  for (const reg of cancelResult.registrations) {
    enqueueRegistrationCancelled({
      registrationId: reg.id,
      studentId: reg.studentId,
      competitionId,
      registrationType: "team",
    }).catch((err: unknown) => {
      logger.warn("registration.cancelled.enqueue_failed", {
        registrationId: reg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return cancelResult;
};
