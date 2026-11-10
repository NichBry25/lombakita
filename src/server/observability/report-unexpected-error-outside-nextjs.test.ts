// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { sentryModule, loggerErrorMock, afterMock } = vi.hoisted(() => ({
  sentryModule: { loaded: false },
  loggerErrorMock: vi.fn(),
  afterMock: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: loggerErrorMock, info: vi.fn() },
}));
vi.mock("@sentry/nextjs", () => {
  sentryModule.loaded = true;
  return { captureException: vi.fn() };
});
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: afterMock,
}));

import { reportUnexpectedError } from "@/server/observability/report-unexpected-error";

describe("reportUnexpectedError outside Next.js", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not load the Sentry SDK when NEXT_RUNTIME is unset", async () => {
    vi.stubEnv("NEXT_RUNTIME", undefined);

    reportUnexpectedError("an access-guarded route", new Error("boom"));
    await vi.dynamicImportSettled();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(afterMock).not.toHaveBeenCalled();
    expect(sentryModule.loaded).toBe(false);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });
});
