import { after } from "next/server";
import { logger } from "@/lib/logger";

const SENTRY_FLUSH_TIMEOUT_MS = 2000;

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

const sendToSentryAndFlush = async (where: string, error: unknown): Promise<void> => {
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(error, { tags: { where } });
    const flushed = await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS);
    if (!flushed) {
      logger.warn("route.unexpected_error.sentry_unflushed", { where });
    }
  } catch {
    logger.warn("route.unexpected_error.sentry_failed", { where });
  }
};

// NEXT_RUNTIME is set by Next.js in both of its runtimes and never by the Railway worker, which
// also loads this module (its own Sentry setup is src/server/observability/worker-sentry.ts).
// after() keeps a Vercel function alive until the flush settles, and throws outside a request.
const captureInSentryAfterResponse = (where: string, error: unknown): void => {
  if (!process.env.NEXT_RUNTIME) {
    return;
  }
  try {
    after(() => sendToSentryAndFlush(where, error));
  } catch {
    logger.warn("route.unexpected_error.sentry_skipped", { where });
  }
};

/**
 * Records an error that a caller did not expect, before the caller answers with its fixed error.
 * The log line carries only the error's class and the "at" lines of its stack, never its message.
 * Inside Next.js the whole error also goes to Sentry, whose server beforeSend replaces a database
 * error's parameters (src/lib/observability/scrub-sentry-event.ts).
 */
export const reportUnexpectedError = (where: string, error: unknown): void => {
  logger.error("route.unexpected_error", { where, ...describeUnexpectedError(error) });
  captureInSentryAfterResponse(where, error);
};
