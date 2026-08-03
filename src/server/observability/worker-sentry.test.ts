// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { initMock, captureExceptionMock } = vi.hoisted(() => ({
  initMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));
vi.mock("@sentry/node", () => ({ init: initMock, captureException: captureExceptionMock }));

const { serverEnvMock } = vi.hoisted(() => ({
  serverEnvMock: { sentryDsn: undefined as string | undefined, appEnv: "preview" as string },
}));
vi.mock("@/config/env.server", () => ({ serverEnv: serverEnvMock }));

import {
  captureWorkerJobFailure,
  initializeWorkerSentry,
} from "@/server/observability/worker-sentry";

const failure = {
  queueName: "infrastructure",
  jobName: "retention.purge",
  jobId: "job_1",
  attemptsMade: 3,
  attemptsPlanned: 3,
  error: new Error("purge failed"),
} as Parameters<typeof captureWorkerJobFailure>[0];

describe("worker Sentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverEnvMock.sentryDsn = undefined;
    serverEnvMock.appEnv = "preview";
  });

  it("does not initialize when SENTRY_DSN is absent", () => {
    initializeWorkerSentry();

    expect(initMock).not.toHaveBeenCalled();
  });

  it("initializes with the environment tag so preview and production events are separable", () => {
    serverEnvMock.sentryDsn = "https://key@o1.ingest.sentry.io/2";
    serverEnvMock.appEnv = "production";

    initializeWorkerSentry();

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://key@o1.ingest.sentry.io/2",
        environment: "production",
      }),
    );
  });

  it("reports a job failure with queue, job and attempt context", () => {
    serverEnvMock.sentryDsn = "https://key@o1.ingest.sentry.io/2";

    captureWorkerJobFailure(failure);

    expect(captureExceptionMock).toHaveBeenCalledWith(
      failure.error,
      expect.objectContaining({
        tags: { queueName: "infrastructure", jobName: "retention.purge" },
        extra: { jobId: "job_1", attemptsMade: 3, attemptsPlanned: 3 },
      }),
    );
  });

  it("stays silent when Sentry is unconfigured, so the worker never reports into a void", () => {
    captureWorkerJobFailure(failure);

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
