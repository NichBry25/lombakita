import { logger } from "@/lib/logger";

type UnexpectedErrorDetails = { errorClass: string; stackFrames?: string } | { errorType: string };

/**
 * The "at" lines of an error's stack. The stack opens with the message, which can span several
 * lines and carry query parameters, so those opening lines are dropped by count.
 */
const readStackFrames = (stack: string, message: string): string =>
  stack
    .split("\n")
    .slice(message.split("\n").length)
    .filter((line) => line.trimStart().startsWith("at "))
    .join("\n");

const describeUnexpectedError = (error: unknown): UnexpectedErrorDetails => {
  if (!(error instanceof Error)) {
    return { errorType: typeof error };
  }
  // Reporting must never replace the caller's fixed answer, so an error whose fields cannot be
  // read as text is described by its class alone.
  try {
    const { stack, message } = error;
    const errorClass = String(error.constructor.name);
    if (typeof stack !== "string" || typeof message !== "string") {
      return { errorClass };
    }
    return { errorClass, stackFrames: readStackFrames(stack, message) };
  } catch {
    return { errorClass: "unreadable" };
  }
};

/**
 * Records an error that a caller did not expect, before the caller answers with its fixed error.
 * Only the error's class and the "at" lines of its stack are logged, never its message. Sentry is
 * not called from here because this module also runs in the Railway worker, where
 * `@sentry/nextjs` captures nothing (src/server/observability/worker-sentry.ts).
 */
export const reportUnexpectedError = (where: string, error: unknown): void => {
  logger.error("route.unexpected_error", { where, ...describeUnexpectedError(error) });
};
