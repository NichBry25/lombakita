import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/config");

import type { JobsOptions, KeepJobs } from "bullmq";
import { serverEnv } from "@/config/env.server";

const KEEP_COMPLETED: KeepJobs = {
  age: 60 * 60,
  count: 1000,
};

const KEEP_FAILED: KeepJobs = {
  age: 60 * 60 * 24,
  count: 5000,
};

export const ASYNC_JOB_DEFAULT_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 1000,
  },
  removeOnComplete: KEEP_COMPLETED,
  removeOnFail: KEEP_FAILED,
};

export const getWorkerConcurrency = (): number => {
  return Math.max(1, serverEnv.workerConcurrency);
};
