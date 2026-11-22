// @vitest-environment node

import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  loggerErrorMock,
  loggerWarnMock,
  captureExceptionMock,
  flushMock,
  scheduledTasks,
  afterMock,
} = vi.hoisted(() => {
  const scheduledTasks: Array<() => unknown> = [];
  return {
    loggerErrorMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    flushMock: vi.fn(async () => true),
    scheduledTasks,
    afterMock: vi.fn((task: () => unknown) => {
      scheduledTasks.push(task);
    }),
  };
});
vi.mock("@/lib/logger", () => ({
  logger: { warn: loggerWarnMock, error: loggerErrorMock, info: vi.fn() },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: captureExceptionMock, flush: flushMock }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: afterMock,
}));

import { reportUnexpectedError } from "@/server/observability/report-unexpected-error";

describe("reportUnexpectedError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduledTasks.length = 0;
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

  it("sends the error to Sentry with where as a tag after the response, then flushes", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const error = new Error("boom");

    reportUnexpectedError("an access-guarded route", error);

    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    await scheduledTasks[0]!();
    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      tags: { where: "an access-guarded route" },
    });
    expect(flushMock).toHaveBeenCalledWith(2000);
    expect(captureExceptionMock.mock.invocationCallOrder[0]).toBeLessThan(
      flushMock.mock.invocationCallOrder[0]!,
    );
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("logs a warning naming only where when Sentry fails", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    captureExceptionMock.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });

    reportUnexpectedError("an access-guarded route", new Error("boom"));

    await expect(scheduledTasks[0]!()).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith("route.unexpected_error.sentry_failed", {
      where: "an access-guarded route",
    });
    expect(flushMock).not.toHaveBeenCalled();
  });

  it("logs a warning naming only where when the flush times out", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    flushMock.mockResolvedValueOnce(false);

    reportUnexpectedError("an access-guarded route", new Error("boom"));

    await expect(scheduledTasks[0]!()).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith("route.unexpected_error.sentry_unflushed", {
      where: "an access-guarded route",
    });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the scheduled task open until the flush settles", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    let settleFlush: (flushed: boolean) => void = () => {};
    flushMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleFlush = resolve;
        }),
    );

    reportUnexpectedError("an access-guarded route", new Error("boom"));

    let taskSettled = false;
    const task = Promise.resolve(scheduledTasks[0]!()).then(() => {
      taskSettled = true;
    });
    await vi.waitFor(() => expect(flushMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taskSettled).toBe(false);
    settleFlush(true);
    await task;
    expect(taskSettled).toBe(true);
  });

  it("logs a warning naming only where when after() is refused outside a request", () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    afterMock.mockImplementationOnce(() => {
      throw new Error("outside a request");
    });

    expect(() => reportUnexpectedError("an access-guarded route", new Error("boom"))).not.toThrow();

    expect(loggerWarnMock).toHaveBeenCalledWith("route.unexpected_error.sentry_skipped", {
      where: "an access-guarded route",
    });
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });
});
