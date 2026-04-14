import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/probe");

import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type AsyncProbeJobPayload } from "@/server/async/contracts";

export type AsyncProbeJob = Job<AsyncProbeJobPayload, void, typeof ASYNC_JOB_NAMES.probePing>;

export const processProbeJob = async (job: AsyncProbeJob): Promise<void> => {
  await job.updateProgress(100);

  logger.info("Async probe job processed", {
    queueName: job.queueName,
    jobName: job.name,
    jobId: job.id,
    probeId: job.data.probeId,
    triggeredBy: job.data.triggeredBy,
  });
};
