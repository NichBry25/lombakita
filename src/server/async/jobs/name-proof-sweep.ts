import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/name-proof-sweep");

import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type NameProofSweepPayload } from "@/server/async/contracts";
import { sweepNameProofs } from "@/server/institution-verification/name-check-service";

export type NameProofSweepJob = Job<
  NameProofSweepPayload,
  void,
  typeof ASYNC_JOB_NAMES.nameProofSweep
>;

// A thin wrapper: every decision lives in sweepNameProofs, where it is testable against a real
// database without a queue.
export const processNameProofSweepJob = async (job: NameProofSweepJob): Promise<void> => {
  const result = await sweepNameProofs(new Date());

  logger.info("name_proof.sweep.job_completed", {
    jobId: job.id,
    reminded: result.reminded.length,
    reminderEnqueueFailed: result.reminderEnqueueFailed.length,
    removed: result.removed.length,
    removalMissed: result.removalMissed.length,
    removalFailed: result.removalFailed.length,
  });
};
