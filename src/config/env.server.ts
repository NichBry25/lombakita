import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("config/env.server");

const read = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const serverEnv = {
  databaseUrl: read(process.env.DATABASE_URL),
  authUrl: read(process.env.AUTH_URL),
  authSecret: read(process.env.AUTH_SECRET),
  redisUrl: read(process.env.REDIS_URL),
  meilisearchHost: read(process.env.MEILISEARCH_HOST),
  meilisearchApiKey: read(process.env.MEILISEARCH_API_KEY),
  r2Endpoint: read(process.env.R2_ENDPOINT),
  r2Region: read(process.env.R2_REGION) ?? "auto",
  r2Bucket: read(process.env.R2_BUCKET),
  r2AccessKeyId: read(process.env.R2_ACCESS_KEY_ID),
  r2SecretAccessKey: read(process.env.R2_SECRET_ACCESS_KEY),
  postmarkServerToken: read(process.env.POSTMARK_SERVER_TOKEN),
  xenditSecretKey: read(process.env.XENDIT_SECRET_KEY),
  sentryDsn: read(process.env.SENTRY_DSN),
  workerConcurrency: Number.parseInt(process.env.WORKER_CONCURRENCY ?? "5", 10),
  logLevel: read(process.env.LOG_LEVEL) ?? "info",
  connectorHealthProbeEnabled: process.env.CONNECTOR_HEALTH_PROBE_ENABLED === "true",
} as const;

export const REQUIRED_ENV_KEYS_BY_MILESTONE = {
  beforeCoding: [],
  beforeStaging: ["AUTH_SECRET", "DATABASE_URL", "REDIS_URL"],
  beforeMvpLaunch: ["POSTMARK_SERVER_TOKEN", "XENDIT_SECRET_KEY"],
  beforeBeta: [],
} as const;

export type RequiredMilestone = keyof typeof REQUIRED_ENV_KEYS_BY_MILESTONE;

export const getRequiredEnvValues = (
  keys: readonly string[],
): Array<{ key: string; configured: boolean }> => {
  return keys.map((key) => ({
    key,
    configured: Boolean(process.env[key]),
  }));
};
