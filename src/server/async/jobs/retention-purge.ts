import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/retention-purge");

import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { isR2Available } from "@/server/storage/r2.client";
import { ASYNC_JOB_NAMES, type RetentionPurgePayload } from "@/server/async/contracts";
import {
  listCompetitionsDueForSubmissionPurge,
  purgeUnfinalizedSubmissionsForCompetition,
} from "@/server/submissions/submission-service";
import {
  listCompetitionsDueForDocumentPurge,
  purgeDocumentsForCompetition,
} from "@/server/registration-documents/registration-document-service";

export type RetentionPurgeJob = Job<
  RetentionPurgePayload,
  void,
  typeof ASYNC_JOB_NAMES.retentionPurge
>;

type SweepOutcome = {
  competitionsDue: number;
  competitionsPurged: number;
  competitionsFailed: number;
};

/**
 * Runs one purge over every competition a due-list returns, isolating failures.
 *
 * A competition whose purge throws is logged and skipped rather than aborting the run: one
 * unreachable object must not stop every other competition's retention from being honoured, and
 * the next scheduled run picks it up again. This is why the job does not simply let the error
 * propagate to BullMQ's retry — a retry would re-run the competitions that already succeeded.
 */
const sweepDueCompetitions = async (
  label: string,
  due: string[],
  purge: (competitionId: string) => Promise<unknown>,
): Promise<SweepOutcome> => {
  let competitionsPurged = 0;
  let competitionsFailed = 0;

  for (const competitionId of due) {
    try {
      await purge(competitionId);
      competitionsPurged += 1;
    } catch (error: unknown) {
      competitionsFailed += 1;
      logger.error("retention.purge.competition_failed", {
        sweep: label,
        competitionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { competitionsDue: due.length, competitionsPurged, competitionsFailed };
};

/**
 * The platform's retention sweep. Fires on a timer (never from a request) and reclaims, for every
 * competition past its grace window:
 *
 *   1. unfinalized competition submissions — abandoned draft uploads, never entered. A FINALIZED
 *      submission is never touched; it is the participant's entry and what a published result
 *      rests on.
 *   2. participant verification documents — students' identity documents, whose whole retention
 *      argument is that holding them after they stop being evidence is a liability.
 *
 * Both are no-ops when nothing is due, so the daily run is cheap on an idle platform.
 *
 * Storage being unavailable is a SKIP, not a failure: retrying a purge against absent storage
 * would spin the queue for no benefit, and retention is not so time-critical that one missed day
 * matters. The next run picks it up.
 */
export const processRetentionPurgeJob = async (job: RetentionPurgeJob): Promise<void> => {
  if (!isR2Available()) {
    logger.warn("retention.purge.skipped_storage_unavailable", {
      scheduledFor: job.data.scheduledFor,
    });
    return;
  }

  const [submissionsDue, documentsDue] = await Promise.all([
    listCompetitionsDueForSubmissionPurge(),
    listCompetitionsDueForDocumentPurge(),
  ]);

  const submissions = await sweepDueCompetitions(
    "unfinalized_submissions",
    submissionsDue,
    purgeUnfinalizedSubmissionsForCompetition,
  );
  const documents = await sweepDueCompetitions(
    "registration_documents",
    documentsDue,
    purgeDocumentsForCompetition,
  );

  logger.info("retention.purge.completed", {
    scheduledFor: job.data.scheduledFor,
    submissions,
    documents,
  });
};
