import { logger } from "@/lib/logger";

/**
 * Records an error that a caller did not expect, before the caller answers with its fixed error.
 * Only the error's class and the "at" lines of its stack are logged. The stack opens with the
 * message, which can span several lines and carry query parameters, so those opening lines are
 * dropped by count and the message is never written to the log or the response.
 */
export const reportUnexpectedError = (where: string, error: unknown): void => {
  const details =
    error instanceof Error
      ? {
          errorClass: error.constructor.name,
          stackFrames: error.stack
            ?.split("\n")
            .slice(error.message.split("\n").length)
            .filter((line) => line.trimStart().startsWith("at "))
            .join("\n"),
        }
      : { errorType: typeof error };
  logger.error(`unexpected error in ${where}`, details);
};
