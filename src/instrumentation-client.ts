import * as Sentry from "@sentry/nextjs";

import { publicEnv } from "@/config/env";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "@/lib/observability/scrub-sentry-event";

// publicEnv rather than serverEnv: this file runs in the browser, where importing the server env
// module throws. NEXT_PUBLIC_APP_ENV is what makes this correct on a preview deployment — VERCEL_ENV
// is not inlined into the client bundle, so without it every browser event would tag as production.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: publicEnv.appEnv,
  tracesSampleRate: 0,
  beforeSend: scrubSentryEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
