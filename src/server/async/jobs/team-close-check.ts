import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/team-close-check");

import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type TeamCloseCheckPayload } from "@/server/async/contracts";
import { runTeamCloseCheck } from "@/server/teams/team-close-check-service";

export type TeamCloseCheckJob = Job<
  TeamCloseCheckPayload,
  void,
  typeof ASYNC_JOB_NAMES.teamCloseCheck
>;

// A thin wrapper: every decision lives in runTeamCloseCheck, where it is testable against a real
// database without a queue.
export const processTeamCloseCheckJob = async (job: TeamCloseCheckJob): Promise<void> => {
  const result = await runTeamCloseCheck();

  logger.info("team.close_check.job_completed", {
    jobId: job.id,
    competitionsExamined: result.competitionsExamined,
    competitionsFailed: result.competitionsFailed,
    invitationsClosed: result.invitationsClosed,
    teamsCancelled: result.teamsCancelled,
    remindersMarked: result.remindersMarked,
  });
};
