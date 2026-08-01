import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  canCancelCompetitionForInsufficientParticipation,
  canConfirmCompetitionWillProceed,
  deriveCompetitionParticipationState,
  INSUFFICIENT_PARTICIPANTS_REASON,
  type CompetitionParticipationState,
} from "@/lib/competitions/competition-participation";
import { logger } from "@/lib/logger";
import { enqueueCompetitionCancelled, enqueueCompetitionSearchSync } from "@/server/async/enqueue";
import { CompetitionError } from "@/server/competitions/competition-core";
import { INSTITUTION_CANCELLATION_REASON } from "@/server/competitions/competition-lifecycle";
import {
  assertCompetitionAccess,
  PUBLIC_COMPETITION_COLUMNS,
  type CompetitionRow,
} from "@/server/competitions/competition-access";
import { acquireCompetitionParticipationLock } from "@/server/competitions/competition-participation-lock";
import { getDb, type Database } from "@/server/db/client";
import { competitionRegistrations, competitions } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-participation-service");

export type CompetitionParticipationSummary = {
  minimumParticipantEntries: number | null;
  participantConfirmationAt: Date | null;
  participationConfirmedAt: Date | null;
  participantEntryCount: number;
  state: CompetitionParticipationState;
  canCancel: boolean;
  canConfirmProceed: boolean;
};

type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export const participantEntryCountSql = sql<number>`(
  count(*) filter (where ${competitionRegistrations.registrationType} = 'individual')
  + count(distinct ${competitionRegistrations.teamId})
    filter (where ${competitionRegistrations.registrationType} = 'team')
)::int`;

// Counts threshold entries rather than physical people. Individual registration rows each count
// once; all active rows carrying the same team_id collapse to one submitted-team entry.
export const countCompetitionParticipantEntries = async (
  competitionId: string,
  db: DbOrTx = getDb(),
): Promise<number> => {
  const [row] = await db
    .select({
      count: participantEntryCountSql,
    })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        ne(competitionRegistrations.status, "cancelled"),
      ),
    );

  return row?.count ?? 0;
};

export const getCompetitionParticipationSummary = async (
  competition: CompetitionRow,
  db: DbOrTx = getDb(),
  now: Date = new Date(),
): Promise<CompetitionParticipationSummary> => {
  const participantEntryCount = await countCompetitionParticipantEntries(competition.id, db);
  const input = {
    minimumParticipantEntries: competition.minimumParticipantEntries,
    participantConfirmationAt: competition.participantConfirmationAt,
    participationConfirmedAt: competition.participationConfirmedAt,
    eventStartAt: competition.eventStartAt,
    cancelledAt: competition.cancelledAt,
    participantEntryCount,
  };

  return {
    minimumParticipantEntries: competition.minimumParticipantEntries,
    participantConfirmationAt: competition.participantConfirmationAt,
    participationConfirmedAt: competition.participationConfirmedAt,
    participantEntryCount,
    state: deriveCompetitionParticipationState(input, now),
    canCancel: canCancelCompetitionForInsufficientParticipation(input, now),
    canConfirmProceed: canConfirmCompetitionWillProceed(input, now),
  };
};

const requireParticipationDecision = async (
  competition: CompetitionRow,
  db: DbOrTx,
  now: Date,
): Promise<CompetitionParticipationSummary> => {
  if (competition.status !== "published") {
    throw new CompetitionError(
      "competition_participation_decision_unavailable",
      409,
      "Participation can only be decided for a published competition",
    );
  }
  if (competition.cancelledAt) {
    throw new CompetitionError(
      "competition_already_cancelled",
      409,
      "This competition has already been cancelled",
    );
  }
  if (
    competition.minimumParticipantEntries === null ||
    competition.minimumParticipantEntries < 1 ||
    competition.participantConfirmationAt === null
  ) {
    throw new CompetitionError(
      "competition_participation_not_configured",
      409,
      "This competition has no minimum-participation rule",
    );
  }

  const summary = await getCompetitionParticipationSummary(competition, db, now);
  if (summary.state !== "decision_due") {
    const message =
      summary.state === "collecting_entries"
        ? "The participation decision is not available before participantConfirmationAt"
        : "The competition is already confirmed and can no longer be cancelled";
    throw new CompetitionError("competition_participation_decision_unavailable", 409, message);
  }

  return summary;
};

const loadCompetitionForParticipationDecision = async (
  competitionId: string,
  db: DbOrTx,
): Promise<CompetitionRow> => {
  const [competition] = await db
    .select(PUBLIC_COMPETITION_COLUMNS)
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);

  if (!competition) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }

  return competition;
};

export type CompetitionParticipationDecisionResult = {
  competition: CompetitionRow;
  cancelledRegistrationCount: number;
};

export const cancelCompetitionForInsufficientParticipation = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
  now?: Date,
): Promise<CompetitionParticipationDecisionResult> => {
  await assertCompetitionAccess(actorUserId, competitionId, "admin", db);

  const result = await db.transaction(async (tx) => {
    await acquireCompetitionParticipationLock(tx, competitionId);
    const decisionAt = now ?? new Date();
    const competition = await loadCompetitionForParticipationDecision(competitionId, tx);
    await requireParticipationDecision(competition, tx, decisionAt);

    const [cancelledCompetition] = await tx
      .update(competitions)
      .set({
        cancelledAt: decisionAt,
        cancellationReason: INSUFFICIENT_PARTICIPANTS_REASON,
        updatedAt: decisionAt,
      })
      .where(
        and(
          eq(competitions.id, competitionId),
          eq(competitions.status, "published"),
          isNull(competitions.cancelledAt),
          isNull(competitions.participationConfirmedAt),
        ),
      )
      .returning(PUBLIC_COMPETITION_COLUMNS);

    if (!cancelledCompetition) {
      throw new CompetitionError(
        "competition_participation_decision_unavailable",
        409,
        "Competition participation was decided concurrently — reload and try again",
      );
    }

    const cancelledRegistrations = await tx
      .update(competitionRegistrations)
      .set({
        status: "cancelled",
        cancelledAt: decisionAt,
        cancellationReason: INSTITUTION_CANCELLATION_REASON,
        updatedAt: decisionAt,
      })
      .where(
        and(
          eq(competitionRegistrations.competitionId, competitionId),
          ne(competitionRegistrations.status, "cancelled"),
        ),
      )
      .returning({ id: competitionRegistrations.id });

    return {
      competition: cancelledCompetition,
      cancelledRegistrationCount: cancelledRegistrations.length,
      decisionAt,
    };
  });

  logger.info("competition.cancelled.insufficient-participation", {
    competitionId,
    actorUserId,
    cancelledRegistrations: result.cancelledRegistrationCount,
  });

  enqueueCompetitionSearchSync({ competitionId, action: "upsert" }).catch((error) => {
    logger.warn("competition.search-sync.enqueue-failed", {
      competitionId,
      action: "upsert",
      error: error instanceof Error ? error.message : String(error),
    });
  });
  enqueueCompetitionCancelled({ competitionId, epoch: result.decisionAt.getTime() }).catch(
    (error) => {
      logger.warn("competition.cancelled.enqueue-failed", {
        competitionId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );

  return {
    competition: result.competition,
    cancelledRegistrationCount: result.cancelledRegistrationCount,
  };
};

export const confirmCompetitionWillProceed = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
  now?: Date,
): Promise<CompetitionParticipationDecisionResult> => {
  await assertCompetitionAccess(actorUserId, competitionId, "admin", db);

  const competition = await db.transaction(async (tx) => {
    await acquireCompetitionParticipationLock(tx, competitionId);
    const decisionAt = now ?? new Date();
    const currentCompetition = await loadCompetitionForParticipationDecision(competitionId, tx);
    await requireParticipationDecision(currentCompetition, tx, decisionAt);

    const [confirmedCompetition] = await tx
      .update(competitions)
      .set({ participationConfirmedAt: decisionAt, updatedAt: decisionAt })
      .where(
        and(
          eq(competitions.id, competitionId),
          eq(competitions.status, "published"),
          isNull(competitions.cancelledAt),
          isNull(competitions.participationConfirmedAt),
        ),
      )
      .returning(PUBLIC_COMPETITION_COLUMNS);

    if (!confirmedCompetition) {
      throw new CompetitionError(
        "competition_participation_decision_unavailable",
        409,
        "Competition participation was decided concurrently — reload and try again",
      );
    }

    return confirmedCompetition;
  });

  logger.info("competition.participation.confirmed", { competitionId, actorUserId });
  return { competition, cancelledRegistrationCount: 0 };
};
