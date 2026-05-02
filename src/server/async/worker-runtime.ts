import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/worker-runtime");

import type Redis from "ioredis";
import { QueueEvents, Worker, type Job } from "bullmq";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { getWorkerConcurrency } from "@/server/async/config";
import {
  type AsyncJobName,
  type AsyncJobPayloadByName,
  type AsyncQueueName,
} from "@/server/async/contracts";
import {
  logProcessFailed,
  logProcessRetryScheduled,
  logProcessStarted,
  logProcessSucceeded,
  toSafeErrorMessage,
} from "@/server/async/observability";
import { getQueueRegistrations, getRegisteredQueueNames } from "@/server/async/registry";
import { createBullmqRedisClient } from "@/server/redis/client";

type QueueWorkerBundle = {
  queueName: AsyncQueueName;
  worker: Worker;
  queueEvents: QueueEvents;
};

export type AsyncWorkerRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const resolvePlannedAttempts = (job: Job): number => {
  const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
  return Math.max(1, attempts);
};

const resolveDurationMs = (job: Job): number | undefined => {
  if (job.processedOn === undefined || job.finishedOn === undefined) {
    return undefined;
  }

  return Math.max(0, job.finishedOn - job.processedOn);
};

const resolveRetryPending = (job: Job): boolean => {
  return job.attemptsMade < resolvePlannedAttempts(job);
};

const toAsyncJobName = (rawName: string): AsyncJobName => {
  return rawName as AsyncJobName;
};

export const createAsyncWorkerRuntime = (): AsyncWorkerRuntime => {
  const connections: Redis[] = [];
  const bundles: QueueWorkerBundle[] = [];
  const concurrency = getWorkerConcurrency();

  const createConnection = (): Redis => {
    const connection = createBullmqRedisClient();
    connections.push(connection);
    return connection;
  };

  const queueNames = getRegisteredQueueNames();

  for (const queueName of queueNames) {
    const registrations = getQueueRegistrations(queueName);
    const processorsByJobName = new Map(
      registrations.map((registration) => [registration.jobName, registration.process]),
    );

    const worker = new Worker(
      queueName,
      async (job) => {
        const asyncJobName = toAsyncJobName(job.name);
        const processor = processorsByJobName.get(asyncJobName);

        if (!processor) {
          throw new Error(`No processor registered for job '${job.name}' on queue '${queueName}'`);
        }

        await processor(job as Job<AsyncJobPayloadByName[AsyncJobName], void, AsyncJobName>);
      },
      {
        connection: createConnection(),
        concurrency,
      },
    );

    const queueEvents = new QueueEvents(queueName, {
      connection: createConnection(),
    });

    worker.on("active", (job) => {
      if (!job?.id) {
        return;
      }

      logProcessStarted({
        queueName,
        jobName: toAsyncJobName(job.name),
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        attemptsPlanned: resolvePlannedAttempts(job),
      });
    });

    worker.on("completed", (job) => {
      if (!job?.id) {
        return;
      }

      logProcessSucceeded({
        queueName,
        jobName: toAsyncJobName(job.name),
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        attemptsPlanned: resolvePlannedAttempts(job),
        durationMs: resolveDurationMs(job),
      });
    });

    worker.on("failed", (job, error) => {
      if (!job?.id) {
        return;
      }

      const errorMessage = toSafeErrorMessage(error);

      logProcessFailed({
        queueName,
        jobName: toAsyncJobName(job.name),
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        attemptsPlanned: resolvePlannedAttempts(job),
        errorMessage,
      });

      if (resolveRetryPending(job)) {
        logProcessRetryScheduled({
          queueName,
          jobName: toAsyncJobName(job.name),
          jobId: job.id,
          attemptsMade: job.attemptsMade,
          attemptsPlanned: resolvePlannedAttempts(job),
          errorMessage,
        });
      }
    });

    worker.on("error", (error) => {
      logger.error("Async worker error", {
        queueName,
        detail: toSafeErrorMessage(error),
      });
    });

    queueEvents.on("stalled", ({ jobId }) => {
      logger.warn("Async job stalled", {
        queueName,
        jobId,
      });
    });

    queueEvents.on("error", (error) => {
      logger.error("Async queue events error", {
        queueName,
        detail: toSafeErrorMessage(error),
      });
    });

    bundles.push({
      queueName,
      worker,
      queueEvents,
    });
  }

  const start = async (): Promise<void> => {
    await Promise.all(
      bundles.flatMap((bundle) => [
        bundle.worker.waitUntilReady(),
        bundle.queueEvents.waitUntilReady(),
      ]),
    );

    logger.info("Async worker runtime started", {
      runtimeName: serverEnv.runtimeName,
      appEnv: serverEnv.appEnv,
      workerRuntimeTarget: serverEnv.workerRuntimeTarget,
      workerDeployRef: serverEnv.workerDeployRef,
      queueNames: bundles.map((bundle) => bundle.queueName),
      concurrency,
    });
  };

  const stop = async (): Promise<void> => {
    const shutdownResults = await Promise.allSettled(
      bundles.map(async (bundle) => {
        await bundle.queueEvents.close();
        await bundle.worker.close();
      }),
    );

    for (const result of shutdownResults) {
      if (result.status === "rejected") {
        logger.warn("Async worker runtime close warning", {
          detail: toSafeErrorMessage(result.reason),
        });
      }
    }

    for (const connection of connections) {
      connection.disconnect();
    }

    logger.info("Async worker runtime stopped", {
      queueNames: bundles.map((bundle) => bundle.queueName),
    });
  };

  return {
    start,
    stop,
  };
};
