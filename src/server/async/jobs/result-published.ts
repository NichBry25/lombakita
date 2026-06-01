import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/result-published");

// Step 5.3 stub — logs receipt of result.published job.
// Email dispatch (recipients lookup, template rendering, Resend call) is Step 6.1 territory.
// This stub is registered so the queue does not accumulate dead-letter noise while Step 6.1
// is pending. When Step 6.1 activates, replace this body with the real dispatch logic.
import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type ResultPublishedPayload } from "@/server/async/contracts";

export type ResultPublishedJob = Job<
  ResultPublishedPayload,
  void,
  typeof ASYNC_JOB_NAMES.resultPublished
>;

export const processResultPublishedJob = async (job: ResultPublishedJob): Promise<void> => {
  logger.info("result.published.stub", {
    jobId: job.id,
    registrationId: job.data.registrationId,
    competitionId: job.data.competitionId,
    teamId: job.data.teamId,
  });
};
