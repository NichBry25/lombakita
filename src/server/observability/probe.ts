import { serverEnv } from "@/config/env.server";

export const isSentryConfigured = (): boolean => {
  return Boolean(serverEnv.sentryDsn) && Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);
};

const assertWellFormedSentryDsn = (dsn: string): void => {
  let parsed: URL;

  try {
    parsed = new URL(dsn);
  } catch {
    throw new Error("SENTRY_DSN is not a valid URL");
  }

  const hasPublicKey = Boolean(parsed.username);
  const hasProjectId = /^\/\d+\/?$/.test(parsed.pathname);

  if (!hasPublicKey || !hasProjectId) {
    throw new Error(
      "SENTRY_DSN is not a well-formed Sentry DSN (expected https://<key>@<host>/<projectId>)",
    );
  }
};

// Format/presence check only — deliberately does not send a live event (mirrors the R2 probe's
// non-invasive HEAD-only precedent). Event-arrival confirmation is a dashboard check, documented
// in the deployment runbook.
export const probeSentry = async (): Promise<void> => {
  const dsn = serverEnv.sentryDsn;
  const publicDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

  if (!dsn) {
    throw new Error("SENTRY_DSN is not configured");
  }

  if (!publicDsn) {
    throw new Error("NEXT_PUBLIC_SENTRY_DSN is not configured");
  }

  if (dsn !== publicDsn) {
    throw new Error("SENTRY_DSN and NEXT_PUBLIC_SENTRY_DSN must match");
  }

  assertWellFormedSentryDsn(dsn);
};
