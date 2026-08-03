import * as Sentry from "@sentry/nextjs";

import { serverEnv } from "@/config/env.server";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: serverEnv.appEnv,
  tracesSampleRate: 1.0,
});
