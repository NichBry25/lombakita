import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/probe");

import { enqueueProbeJob } from "@/server/async/enqueue";
import { getAsyncQueue } from "@/server/async/queue";

export const isAsyncWorkersConfigured = (): boolean => {
  return Boolean(process.env.REDIS_URL);
};

const WORKER_LIVENESS_TIMEOUT_MS = 20_000;
const WORKER_LIVENESS_POLL_INTERVAL_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Confirms a worker process is actually deployed and consuming jobs — not just that Redis/the
// Railway service is up. Enqueues the existing non-business probe job (infrastructure.probe.ping,
// same job used by jobs:probe:enqueue) and polls until a worker picks it up and completes it, or
// the timeout elapses.
export const probeAsyncWorkerLiveness = async (): Promise<void> => {
  const probeId = `connector-status-${Date.now()}`;
  const { jobId, queueName } = await enqueueProbeJob({ probeId, triggeredBy: "script" });
  const queue = getAsyncQueue(queueName);

  const deadline = Date.now() + WORKER_LIVENESS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    const state = await job?.getState();

    if (state === "completed") {
      return;
    }

    if (state === "failed") {
      throw new Error(`probe job failed: ${job?.failedReason ?? "unknown reason"}`);
    }

    await sleep(WORKER_LIVENESS_POLL_INTERVAL_MS);
  }

  throw new Error(
    `no worker consumed the probe job within ${WORKER_LIVENESS_TIMEOUT_MS}ms — confirm the worker process is running and consuming the "${queueName}" queue`,
  );
};
