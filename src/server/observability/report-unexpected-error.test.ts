// @vitest-environment node

import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerErrorMock, captureExceptionMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: loggerErrorMock, info: vi.fn() },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: captureExceptionMock }));

import { reportUnexpectedError } from "@/server/observability/report-unexpected-error";

describe("reportUnexpectedError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("logs the class and the stack frames of a multi-line error, never its message", () => {
    const error = new Error(
      "Failed query: select secret-query\nparams: secret-value\n    at secret-value",
    );

    reportUnexpectedError("an access-guarded route", error);

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [message, details] = loggerErrorMock.mock.calls[0]!;
    expect(message).toBe("route.unexpected_error");
    expect(Object.keys(details)).toEqual(["where", "errorClass", "stackFrames"]);
    expect(details.where).toBe("an access-guarded route");
    expect(details.errorClass).toBe("Error");
    expect(typeof details.stackFrames).toBe("string");
    expect(details.stackFrames).toMatch(/^\s*at /);
    const loggedCalls = inspect(loggerErrorMock.mock.calls, { depth: null });
    expect(loggedCalls).not.toContain("secret-query");
    expect(loggedCalls).not.toContain("secret-value");
  });

  it("logs the class alone for an error whose message is not a string, and does not throw", () => {
    const error = Object.assign(new Error("x"), { message: 42 });

    expect(() => reportUnexpectedError("an access-guarded route", error)).not.toThrow();

    expect(loggerErrorMock).toHaveBeenCalledWith("route.unexpected_error", {
      where: "an access-guarded route",
      errorClass: "Error",
    });
  });

  it("logs an unreadable class for an error whose stack getter throws, and does not throw", () => {
    const error = new Error("x");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("stack unreadable");
      },
    });

    expect(() => reportUnexpectedError("an access-guarded route", error)).not.toThrow();

    expect(loggerErrorMock).toHaveBeenCalledWith("route.unexpected_error", {
      where: "an access-guarded route",
      errorClass: "unreadable",
    });
  });

  it("logs the type of a thrown value that is not an Error", () => {
    reportUnexpectedError("an authentication route", "secret-value");

    expect(loggerErrorMock).toHaveBeenCalledWith("route.unexpected_error", {
      where: "an authentication route",
      errorType: "string",
    });
  });

  it("sends the error to Sentry with where as a tag inside Next.js", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const error = new Error("boom");

    reportUnexpectedError("an access-guarded route", error);

    await vi.waitFor(() =>
      expect(captureExceptionMock).toHaveBeenCalledWith(error, {
        tags: { where: "an access-guarded route" },
      }),
    );
  });

  it("stays silent when Sentry throws", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    captureExceptionMock.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });

    expect(() => reportUnexpectedError("an access-guarded route", new Error("boom"))).not.toThrow();

    await vi.waitFor(() => expect(captureExceptionMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
