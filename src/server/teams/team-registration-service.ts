import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-registration-service");

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import { enqueueRegistrationConfirmed, enqueueRegistrationCancelled } from "@/server/async/enqueue";
import {
  competitionRegistrations,
  competitions,
  teamMemberships,
  teams,
  type CompetitionRegistrationStatus,
} from "@/server/db/schema";
import { TeamError } from "@/server/teams/team-core";
import { MAX_CANCELLATION_REASON_LENGTH } from "@/server/registrations/registration-core";
import { isParticipantCancellationClosedByConfirmation } from "@/lib/competitions/competition-participation";
import { acquireCompetitionParticipationLock } from "@/server/competitions/competition-participation-lock";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import { hasSubmittedPaymentProof } from "@/server/finance/paid-registration";
import {
  createRegistrationPayment,
  loadRegistrationPricing,
} from "@/server/registrations/registration-payment";

const DAY_MS = 24 * 60 * 60 * 1000;

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
  eventStartAt: Date | null;
  participantConfirmationAt: Date | null;
  cancelledAt: Date | null;
  allowCancellation: boolean;
  cancellationCutoffDays: number | null;
  feeAmount: number | null;
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

type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

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
  db: DbOrTx,
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
      eventStartAt: competitions.eventStartAt,
      participantConfirmationAt: competitions.participantConfirmationAt,
      cancelledAt: competitions.cancelledAt,
      allowCancellation: competitions.allowCancellation,
      cancellationCutoffDays: competitions.cancellationCutoffDays,
      feeAmount: competitions.feeAmount,
    })
    .from(competitions)
    .where(and(eq(competitions.id, competitionId), isNull(competitions.deletedAt)))
    .limit(1);
  return row ?? null;
};

const assertCompetitionAcceptsTeamRegistration = (
  competition: CompetitionSnapshot,
  now: Date,
): void => {
  if (competition.status !== "published" || competition.cancelledAt) {
    throw new TeamError(
      "team_competition_not_published",
      "Competition is not open for registration",
    );
  }
  if (competition.mode === "individual") {
    throw new TeamError(
      "team_registration_not_allowed",
      "This competition does not accept team registration",
    );
  }
  if (
    competition.registrationStartAt &&
    competition.registrationStartAt.getTime() > now.getTime()
  ) {
    throw new TeamError("registration_not_yet_open", "Registration window has not yet opened");
  }
  if (!competition.registrationEndAt || competition.registrationEndAt.getTime() <= now.getTime()) {
    throw new TeamError("registration_window_closed", "Registration window has closed");
  }
};

const assertTeamCancellationWindowOpen = (competition: CompetitionSnapshot, now: Date): void => {
  if (isParticipantCancellationClosedByConfirmation(competition.participantConfirmationAt, now)) {
    throw new TeamError(
      "cancellation_window_closed",
      "The cancellation window closed when participation was confirmed",
    );
  }

  const cutoffDays = competition.cancellationCutoffDays;
  if (!competition.eventStartAt || cutoffDays === null) {
    throw new TeamError("cancellation_window_closed", "The cancellation window is closed");
  }
  if (now.getTime() > competition.eventStartAt.getTime() - cutoffDays * DAY_MS) {
    throw new TeamError("cancellation_window_closed", "The cancellation window has closed");
  }
};

const loadActiveMemberUserIds = async (
  teamId: string,
  db: Database,
): Promise<{ membershipId: string; userId: string }[]> => {
  return db
    .select({ membershipId: teamMemberships.id, userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")));
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

// Captain submits the team for the given competition. Pre-transaction guards run in
// the order documented in the implementation prompt. The actual writes happen inside a single
// transaction with a TOCTOU backstop on the team status update.
export const submitTeamRegistration = async (
  callerUserId: string,
  competitionId: string,
  teamId: string,
  db: Database = getDb(),
  now?: Date,
): Promise<TeamRegistrationResult> => {
  const requestAt = now ?? new Date();
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
  // (c-e) publication, mode, and registration window. If start is null the window is treated
  // as immediately open (matches the individual-registration helper which only enforces end).
  assertCompetitionAcceptsTeamRegistration(competition, requestAt);

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

  const memberUserIds = members.map((m) => m.userId);

  // (h) pre-check existing non-cancelled registrations for any member. The partial unique
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
      await acquireCompetitionParticipationLock(tx, competitionId);
      const mutationAt = now ?? new Date();
      const lockedCompetition = await loadCompetition(competitionId, tx);
      if (!lockedCompetition) {
        throw new TeamError("team_competition_not_found", "Competition not found");
      }
      assertCompetitionAcceptsTeamRegistration(lockedCompetition, mutationAt);

      const insertedRows = await tx
        .insert(competitionRegistrations)
        .values(
          memberUserIds.map((userId) => ({
            competitionId,
            studentId: userId,
            teamId,
            registrationType: "team" as const,
            status: "confirmed" as const,
            registeredAt: mutationAt,
          })),
        )
        .returning({
          id: competitionRegistrations.id,
          studentId: competitionRegistrations.studentId,
          status: competitionRegistrations.status,
        });

      const teamUpdate = await tx
        .update(teams)
        .set({ status: "submitted", updatedAt: mutationAt })
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

      // ONE PAYMENT FOR THE WHOLE TEAM, anchored on the CAPTAIN'S row.
      //
      // N members produce N registration rows but a single debt, so the payment attaches to one of
      // them and the payment-group predicates resolve the rest back to it through `team_id`.
      // Charging per row would bill a four-person team four times; anchoring on an arbitrary row
      // would make which member pays depend on insert order.
      //
      // Same transaction as the registrations and the team transition, so a priced team is either
      // fully registered and priced or not registered at all.
      const captainRegistration = insertedRows.find((row) => row.studentId === team.captainId);

      if (!captainRegistration) {
        // The captain is required to be an active member, so this is unreachable. Asserted because
        // silently anchoring on someone else would put another member's name on the debt.
        throw new TeamError(
          "team_registration_invariant_violation",
          "The captain has no registration row to anchor the team's payment on",
        );
      }

      const pricing = await loadRegistrationPricing(competitionId, tx);

      if (pricing) {
        await createRegistrationPayment(
          pricing,
          captainRegistration.id,
          team.captainId,
          mutationAt,
          tx,
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
    // is unreachable today. Mirrors the `team_name_taken` 23505 defense — surfaces
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

// Captain reverts a submitted team back to forming by cancelling every team-typed
// registration row. The same candidate-cancellation policy as the individual path applies:
// reason required, the paid block conditional on a submitted bukti transfer, institution allow
// toggle, and the cutoff window measured against event_start_at. Gate order is fail-closed:
// captain + submitted-status (ownership/state) before any reason or policy error.
export const cancelTeamRegistration = async (
  callerUserId: string,
  competitionId: string,
  teamId: string,
  cancellationReason: string | null,
  db: Database = getDb(),
  now?: Date,
): Promise<TeamRegistrationResult> => {
  const requestAt = now ?? new Date();
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

  // Reason required + bounded (after captain + status gates).
  if (cancellationReason === null || cancellationReason.length === 0) {
    throw new TeamError("cancellation_reason_required", "A cancellation reason is required");
  }
  if (cancellationReason.length > MAX_CANCELLATION_REASON_LENGTH) {
    throw new TeamError(
      "cancellation_reason_too_long",
      `Cancellation reason must be at most ${MAX_CANCELLATION_REASON_LENGTH} characters`,
    );
  }

  const competition = await loadCompetition(competitionId, db);
  if (!competition) {
    throw new TeamError("team_competition_not_found", "Competition not found");
  }

  // The same conditional the individual cancel path applies, deliberately reached through the same
  // predicate rather than restated. A team pays ONCE, anchored on the captain's row, and the
  // predicate resolves the whole payment group — so a captain cancelling a team whose payment is
  // evidenced is refused for exactly the reason an individual would be, and a team that has
  // transferred nothing keeps the right to disband.
  //
  // Leaving this arm blanket while the individual arm became conditional would mean a captain and
  // a solo entrant on the same competition, both having paid nothing, got different answers.
  if (isPaidCompetition(competition.feeAmount)) {
    // ANY member's row identifies the group. The predicate resolves the whole payment group from
    // whichever row it is handed, so this does not need to be the captain's — and asking for a
    // specific member's row here would add a way to get the wrong answer for no benefit. A team
    // with no registration rows at all has no payment and therefore no proof.
    const [groupMember] = await db
      .select({ id: competitionRegistrations.id })
      .from(competitionRegistrations)
      .where(eq(competitionRegistrations.teamId, teamId))
      .limit(1);

    if (groupMember && (await hasSubmittedPaymentProof(groupMember.id, db))) {
      throw new TeamError(
        "cancellation_not_supported_for_paid",
        "Pendaftaran tidak dapat dibatalkan setelah bukti transfer dikirim",
      );
    }
  }

  // Institution must allow cancellation.
  if (!competition.allowCancellation) {
    throw new TeamError(
      "cancellation_disabled_by_institution",
      "Cancellation is not enabled for this competition",
    );
  }

  // Freeze the entry count at the participation-confirmation moment. A team is one threshold
  // entry, so reverting a submitted team after this boundary would reopen a terminal decision.
  assertTeamCancellationWindowOpen(competition, requestAt);

  const cancelResult = await db.transaction(async (tx) => {
    await acquireCompetitionParticipationLock(tx, competitionId);
    const mutationAt = now ?? new Date();
    const lockedCompetition = await loadCompetition(competitionId, tx);
    if (!lockedCompetition) {
      throw new TeamError("team_competition_not_found", "Competition not found");
    }
    assertTeamCancellationWindowOpen(lockedCompetition, mutationAt);

    const cancelled = await tx
      .update(competitionRegistrations)
      .set({
        status: "cancelled",
        cancelledAt: mutationAt,
        cancellationReason,
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
      .set({ status: "forming", updatedAt: mutationAt })
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
