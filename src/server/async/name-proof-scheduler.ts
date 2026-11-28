import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/name-proof-scheduler");

import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import { TEAM_CLOSE_CHECK_TIMEZONE } from "@/server/async/team-close-check-scheduler";
import { getAsyncQueue } from "@/server/async/queue";

// BullMQ keys the schedule by this id, so re-registering with the same id replaces the existing
// schedule instead of adding a second one. That makes it safe on every worker boot.
export const NAME_PROOF_SWEEP_SCHEDULER_ID = "name-proof-sweep-hourly";

// Hourly, so a reminder goes within the hour of its day 21 and the tick of a proof that ran out is
// removed within the hour of its end.
export const NAME_PROOF_SWEEP_CRON = "15 * * * *";
export const NAME_PROOF_SWEEP_TIMEZONE = TEAM_CLOSE_CHECK_TIMEZONE;

/**
 * Registers (or re-registers) the hourly name proof sweep, from the worker runtime. Missed
 * occurrences are not backfilled: a due proof stays selectable while its work remains, so the next
 * run collects it.
 */
export const registerNameProofSweepSchedule = async (): Promise<void> => {
  const queue = getAsyncQueue(ASYNC_QUEUE_NAMES.infrastructure);

  await queue.upsertJobScheduler(
    NAME_PROOF_SWEEP_SCHEDULER_ID,
    { pattern: NAME_PROOF_SWEEP_CRON, tz: NAME_PROOF_SWEEP_TIMEZONE },
    {
      name: ASYNC_JOB_NAMES.nameProofSweep,
      data: { scheduledFor: NAME_PROOF_SWEEP_CRON },
      opts: {
        // One attempt. The sweep isolates each workspace's failure itself, so the next hour is the retry.
        attempts: 1,
      },
    },
  );

  logger.info("name_proof.sweep.schedule_registered", {
    schedulerId: NAME_PROOF_SWEEP_SCHEDULER_ID,
    pattern: NAME_PROOF_SWEEP_CRON,
    timezone: NAME_PROOF_SWEEP_TIMEZONE,
  });
};
