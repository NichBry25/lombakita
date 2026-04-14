import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/observability");

import { logger } from "@/lib/logger";
import type { AsyncJobName, AsyncQueueName } from "@/server/async/contracts";

export type AsyncJobLifecycleEvent =
  | "enqueue.requested"
  | "enqueue.accepted"
  | "process.started"
  | "process.succeeded"
  | "process.failed"
  | "process.retry_scheduled";

type AsyncJobLifecycleContext = {
  queueName: AsyncQueueName;
  jobName: AsyncJobName;
  jobId: string;
  attemptsMade?: number;
  attemptsPlanned?: number;
  idempotencyKey?: string;
  duplicate?: boolean;
  durationMs?: number;
  errorMessage?: string;
};

const writeLifecycleLog = (
  event: AsyncJobLifecycleEvent,
  context: AsyncJobLifecycleContext,
): void => {
  const payload = {
    event,
    queueName: context.queueName,
    jobName: context.jobName,
    jobId: context.jobId,
    attemptsMade: context.attemptsMade,
    attemptsPlanned: context.attemptsPlanned,
    idempotencyKey: context.idempotencyKey,
    duplicate: context.duplicate,
    durationMs: context.durationMs,
    errorMessage: context.errorMessage,
  };

  if (event === "process.failed") {
    logger.error("Async job lifecycle event", payload);
    return;
  }

  if (event === "process.retry_scheduled") {
    logger.warn("Async job lifecycle event", payload);
    return;
  }

  logger.info("Async job lifecycle event", payload);
};

export const logEnqueueRequested = (context: AsyncJobLifecycleContext): void => {
  writeLifecycleLog("enqueue.requested", context);
};

export const logEnqueueAccepted = (context: AsyncJobLifecycleContext): void => {
  writeLifecycleLog("enqueue.accepted", context);
};

export const logProcessStarted = (context: AsyncJobLifecycleContext): void => {
  writeLifecycleLog("process.started", context);
};

export const logProcessSucceeded = (context: AsyncJobLifecycleContext): void => {
  writeLifecycleLog("process.succeeded", context);
};

export const logProcessFailed = (context: AsyncJobLifecycleContext): void => {
  writeLifecycleLog("process.failed", context);
};

export const logProcessRetryScheduled = (context: AsyncJobLifecycleContext): void => {
  writeLifecycleLog("process.retry_scheduled", context);
};

export const toSafeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return "unexpected async processing error";
};
