// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: loggerErrorMock, info: vi.fn() },
}));

import { reportUnexpectedError } from "@/server/observability/report-unexpected-error";

describe("reportUnexpectedError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs the class and the stack frames of a multi-line error, never its message", () => {
    const error = new Error("Failed query: x\nparams: secret-value\n    at secret-value");

    reportUnexpectedError("an access-guarded route", error);

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [message, details] = loggerErrorMock.mock.calls[0]!;
    expect(message).toBe("unexpected error in an access-guarded route");
    expect(details.errorClass).toBe("Error");
    expect(details.stackFrames).toMatch(/^\s*at /);
    expect(JSON.stringify(loggerErrorMock.mock.calls[0])).not.toContain("secret-value");
  });

  it("logs the type of a thrown value that is not an Error", () => {
    reportUnexpectedError("an authentication route", "secret-value");

    expect(loggerErrorMock).toHaveBeenCalledWith("unexpected error in an authentication route", {
      errorType: "string",
    });
  });
});
