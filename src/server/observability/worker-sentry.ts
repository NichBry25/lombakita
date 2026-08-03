/**
 * Sentry for the Railway worker runtime.
 *
 * The three `sentry.*.config.ts` files at the repo root are loaded by `instrumentation.ts`, which
 * only fires under a Next.js runtime — so the worker process, which runs the retention purge and
 * every notification job, reported nothing to Sentry at all.
 *
 * This imports `@sentry/node`, NOT `@sentry/nextjs`. In a bare Node process `@sentry/nextjs`
 * resolves to its browser build (verified: it exports `ErrorBoundary` and `showReportDialog`, and
 * has no `getClient`), so its `init` would install a browser transport with no Node integrations
 * and no uncaught-exception handler — reporting success while capturing nothing.
 */

import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/observability/worker-sentry");

import * as Sentry from "@sentry/node";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import type { AsyncJobName, AsyncQueueName } from "@/server/async/contracts";

export const initializeWorkerSentry = (): void => {
  const dsn = serverEnv.sentryDsn;

  if (!dsn) {
    logger.info("Worker Sentry disabled", { reason: "SENTRY_DSN is not configured" });
    return;
  }

  Sentry.init({
    dsn,
    environment: serverEnv.appEnv,
    tracesSampleRate: 1.0,
  });

  logger.info("Worker Sentry initialized", { appEnv: serverEnv.appEnv });
};

type WorkerJobFailure = {
  queueName: AsyncQueueName;
  jobName: AsyncJobName;
  jobId: string;
  attemptsMade: number;
  attemptsPlanned: number;
  error: unknown;
};

/**
 * Reports a job that has exhausted every attempt.
 *
 * BullMQ catches whatever a processor throws, so an initialized SDK alone would never see a job
 * failure — only a crash of the process itself. Intermediate retries are deliberately not reported:
 * a job that fails once and succeeds on retry is working as designed, and paging on it would train
 * the alert away.
 */
export const captureWorkerJobFailure = (failure: WorkerJobFailure): void => {
  if (!serverEnv.sentryDsn) {
    return;
  }

  Sentry.captureException(failure.error, {
    tags: {
      queueName: failure.queueName,
      jobName: failure.jobName,
    },
    extra: {
      jobId: failure.jobId,
      attemptsMade: failure.attemptsMade,
      attemptsPlanned: failure.attemptsPlanned,
    },
  });
};
