import * as Sentry from "@sentry/nextjs";

import { serverEnv } from "@/config/env.server";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubServerSentryEvent,
} from "@/lib/observability/scrub-sentry-event";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: serverEnv.appEnv,
  tracesSampler: () => 0,
  beforeSend: scrubServerSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
});
