import * as Sentry from "@sentry/nextjs";

import { serverEnv } from "@/config/env.server";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "@/lib/observability/scrub-sentry-event";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: serverEnv.appEnv,
  tracesSampler: () => 0,
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
});
