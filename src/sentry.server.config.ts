import * as Sentry from "@sentry/nextjs";

import { serverEnv } from "@/config/env.server";
import { scrubSentryEvent } from "@/lib/observability/scrub-sentry-event";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: serverEnv.appEnv,
  tracesSampleRate: 0,
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
});
