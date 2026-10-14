import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError: typeof Sentry.captureRequestError = (error, request, context) => {
  // The live read already reports this refusal under its process-wide throttle.
  if (error instanceof Error && "code" in error && error.code === "account_state_unavailable") {
    return;
  }
  Sentry.captureRequestError(error, request, context);
};
