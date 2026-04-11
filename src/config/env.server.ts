import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("config/env.server");

import { resolveAppEnvironment, resolvePublicAppUrl, type AppEnvironment } from "@/config/env";

const read = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  const normalized = read(value)?.toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  return fallback;
};

const DB_SSL_MODES = ["inherit", "disable", "require", "require_insecure"] as const;

export type DatabaseSslMode = (typeof DB_SSL_MODES)[number];

const isDatabaseSslMode = (value: string): value is DatabaseSslMode => {
  return (DB_SSL_MODES as readonly string[]).includes(value);
};

const resolveDatabaseSslMode = (value: string | undefined): DatabaseSslMode => {
  const normalized = read(value)?.toLowerCase();

  if (normalized && isDatabaseSslMode(normalized)) {
    return normalized;
  }

  return "inherit";
};

const SERVER_RUNTIME_VALUES = ["web", "worker"] as const;

export type ServerRuntime = (typeof SERVER_RUNTIME_VALUES)[number];

const isServerRuntime = (value: string): value is ServerRuntime => {
  return (SERVER_RUNTIME_VALUES as readonly string[]).includes(value);
};

export const resolveServerRuntime = (value: string | undefined): ServerRuntime => {
  const normalized = read(value)?.toLowerCase();

  if (normalized && isServerRuntime(normalized)) {
    return normalized;
  }

  return "web";
};

const resolveAppBaseUrl = (env: NodeJS.ProcessEnv): string | undefined => {
  const explicit = read(env.APP_BASE_URL);

  if (explicit) {
    return explicit;
  }

  const authUrl = read(env.AUTH_URL);
  if (authUrl) {
    return authUrl;
  }

  return resolvePublicAppUrl({
    appEnv: resolveAppEnvironment(env.APP_ENV ?? env.NEXT_PUBLIC_APP_ENV),
    explicitUrl: env.NEXT_PUBLIC_APP_URL,
    vercelUrl: env.VERCEL_URL,
  });
};

export const buildServerEnv = (env: NodeJS.ProcessEnv) => {
  const appEnv = resolveAppEnvironment(env.APP_ENV ?? env.NEXT_PUBLIC_APP_ENV);
  const appBaseUrl = resolveAppBaseUrl(env);

  return {
    appEnv,
    runtimeName: resolveServerRuntime(env.RUNTIME_NAME),
    appBaseUrl,
    databaseUrl: read(env.DATABASE_URL),
    migrationDatabaseUrl: read(env.MIGRATION_DATABASE_URL),
    databaseSslMode: resolveDatabaseSslMode(env.DB_SSL_MODE),
    databaseSslRejectUnauthorized: parseBoolean(env.DB_SSL_REJECT_UNAUTHORIZED, true),
    databaseSslCaCertBase64: read(env.DB_SSL_CA_CERT_BASE64),
    authUrl: read(env.AUTH_URL) ?? appBaseUrl,
    authSecret: read(env.AUTH_SECRET),
    authEmailFrom: read(env.AUTH_EMAIL_FROM),
    redisUrl: read(env.REDIS_URL),
    meilisearchHost: read(env.MEILISEARCH_HOST),
    meilisearchApiKey: read(env.MEILISEARCH_API_KEY),
    r2Endpoint: read(env.R2_ENDPOINT),
    r2Region: read(env.R2_REGION) ?? "auto",
    r2Bucket: read(env.R2_BUCKET),
    r2AccessKeyId: read(env.R2_ACCESS_KEY_ID),
    r2SecretAccessKey: read(env.R2_SECRET_ACCESS_KEY),
    resendApiKey: read(env.RESEND_API_KEY),
    xenditSecretKey: read(env.XENDIT_SECRET_KEY),
    sentryDsn: read(env.SENTRY_DSN),
    workerConcurrency: parseInteger(env.WORKER_CONCURRENCY, 5),
    workerRuntimeTarget: read(env.WORKER_RUNTIME_TARGET) ?? "pending_selection",
    workerDeployRef: read(env.WORKER_DEPLOYMENT_REF),
    logLevel: read(env.LOG_LEVEL) ?? "info",
    connectorHealthProbeEnabled: env.CONNECTOR_HEALTH_PROBE_ENABLED === "true",
  } as const;
};

export const serverEnv = buildServerEnv(process.env);

export type ServerEnv = typeof serverEnv;

const isTestContext = (appEnv: AppEnvironment): boolean => {
  return appEnv === "test";
};

export type RuntimeEnvValidation = {
  runtime: ServerRuntime;
  appEnv: AppEnvironment;
  requiredKeys: string[];
  missingKeys: string[];
};

const includeMissing = (
  values: RuntimeEnvValidation,
  key: string,
  isConfigured: boolean,
): RuntimeEnvValidation => {
  values.requiredKeys.push(key);

  if (!isConfigured) {
    values.missingKeys.push(key);
  }

  return values;
};

export const getRuntimeEnvValidation = (
  runtime: ServerRuntime,
  env: ServerEnv = serverEnv,
): RuntimeEnvValidation => {
  const values: RuntimeEnvValidation = {
    runtime,
    appEnv: env.appEnv,
    requiredKeys: [],
    missingKeys: [],
  };

  includeMissing(values, "DATABASE_URL", Boolean(env.databaseUrl));

  if (runtime === "web") {
    includeMissing(values, "AUTH_SECRET", Boolean(env.authSecret));

    if (env.appEnv !== "local" && env.appEnv !== "test") {
      includeMissing(
        values,
        "APP_BASE_URL|AUTH_URL|NEXT_PUBLIC_APP_URL|VERCEL_URL",
        Boolean(env.appBaseUrl),
      );
    }
  }

  if (runtime === "worker" && env.appEnv !== "local" && env.appEnv !== "test") {
    includeMissing(
      values,
      "WORKER_RUNTIME_TARGET",
      env.workerRuntimeTarget !== "pending_selection",
    );
  }

  return values;
};

export const assertRuntimeEnv = (runtime: ServerRuntime, env: ServerEnv = serverEnv): void => {
  const validation = getRuntimeEnvValidation(runtime, env);

  if (isTestContext(validation.appEnv)) {
    return;
  }

  if (validation.missingKeys.length === 0) {
    return;
  }

  throw new Error(
    `Missing required environment variables for ${runtime} runtime: ${validation.missingKeys.join(", ")}`,
  );
};

export const REQUIRED_ENV_KEYS_BY_MILESTONE = {
  beforeCoding: [],
  beforeStaging: ["DATABASE_URL", "AUTH_SECRET", "APP_BASE_URL"],
  beforeMvpLaunch: ["RESEND_API_KEY", "AUTH_EMAIL_FROM", "XENDIT_SECRET_KEY"],
  beforeBeta: ["WORKER_RUNTIME_TARGET"],
} as const;

export type RequiredMilestone = keyof typeof REQUIRED_ENV_KEYS_BY_MILESTONE;

export const getRequiredEnvValues = (
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Array<{ key: string; configured: boolean }> => {
  return keys.map((key) => ({
    key,
    configured: Boolean(read(env[key])),
  }));
};
