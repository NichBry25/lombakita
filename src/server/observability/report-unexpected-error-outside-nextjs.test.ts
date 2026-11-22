// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { loggerErrorMock, afterMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  afterMock: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: loggerErrorMock, info: vi.fn() },
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: afterMock,
}));

import { reportUnexpectedError } from "@/server/observability/report-unexpected-error";

describe("reportUnexpectedError outside Next.js", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not schedule a Sentry report when NEXT_RUNTIME is unset", () => {
    vi.stubEnv("NEXT_RUNTIME", undefined);

    reportUnexpectedError("an access-guarded route", new Error("boom"));

    expect(afterMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });
});
