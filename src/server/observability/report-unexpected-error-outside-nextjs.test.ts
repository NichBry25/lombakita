// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { sentryModule, loggerErrorMock } = vi.hoisted(() => ({
  sentryModule: { loaded: false },
  loggerErrorMock: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: loggerErrorMock, info: vi.fn() },
}));
vi.mock("@sentry/nextjs", () => {
  sentryModule.loaded = true;
  return { captureException: vi.fn() };
});

import { reportUnexpectedError } from "@/server/observability/report-unexpected-error";

describe("reportUnexpectedError outside Next.js", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not load the Sentry SDK when NEXT_RUNTIME is unset", async () => {
    vi.stubEnv("NEXT_RUNTIME", "");

    reportUnexpectedError("an access-guarded route", new Error("boom"));
    await vi.dynamicImportSettled();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentryModule.loaded).toBe(false);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });
});
