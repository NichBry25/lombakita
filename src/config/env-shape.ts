/**
 * Shape and completeness rules for a deployed environment's configuration.
 *
 * This answers a different question from `getRuntimeEnvValidation` in `env.server.ts`, and the two
 * must not be merged. That one gates whether a PROCESS MAY BOOT, so it is deliberately narrow —
 * local development runs with no object storage, no search, and no email provider. This one asks
 * whether a DEPLOYED ENVIRONMENT IS FULLY AND CORRECTLY PROVISIONED, and runs only in CI.
 *
 * Every rule here exists because a value was present, non-empty, and wrong. A presence check
 * cannot see that: `R2_ENDPOINT=R2_ENDPOINT=https://…` is a truthy string, so it passed
 * `isR2Available()`, the app reported storage as available, and uploads threw 500 instead of
 * degrading to the designed 503.
 *
 * Pure and dependency-free so it can be unit-tested against fixture records.
 */

import { CANONICAL_SITE_ORIGIN } from "@/config/company";

export type DeployEnvironment = "preview" | "production";

export type DeployConfigSeverity = "error" | "warning";

export type DeployConfigProblem = {
  key: string;
  severity: DeployConfigSeverity;
  problem: string;
};

type ValueRule = {
  /** Human-readable form the value is expected to take, quoted back in the failure message. */
  expectation: string;
  /**
   * `environment` is passed because one rule is genuinely environment-dependent: a preview
   * deployment's base URL is per-deployment and correct, while production's is a single known
   * address. Every other rule ignores it.
   */
  accepts: (value: string, environment: DeployEnvironment) => boolean;
};

type DeployKeySpec = {
  key: string;
  /** Environments where absence is an error. Absence anywhere else is reported as a warning. */
  requiredIn: readonly DeployEnvironment[];
  rule?: ValueRule;
};

const BOTH: readonly DeployEnvironment[] = ["preview", "production"];
const PRODUCTION_ONLY: readonly DeployEnvironment[] = ["production"];
const NEITHER: readonly DeployEnvironment[] = [];

const parseUrlOrNull = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isPostgresConnectionUrl = (value: string): boolean => {
  const url = parseUrlOrNull(value);

  if (!url || (url.protocol !== "postgres:" && url.protocol !== "postgresql:")) {
    return false;
  }

  const databaseName = url.pathname.replace(/^\//, "");

  return url.hostname.length > 0 && databaseName.length > 0;
};

const isRedisConnectionUrl = (value: string): boolean => {
  const url = parseUrlOrNull(value);

  return Boolean(url && (url.protocol === "redis:" || url.protocol === "rediss:") && url.hostname);
};

const isHttpOrigin = (value: string): boolean => {
  const url = parseUrlOrNull(value);

  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return false;
  }

  return url.hostname.length > 0 && (url.pathname === "" || url.pathname === "/");
};

const isHttpsOrigin = (value: string): boolean => {
  return isHttpOrigin(value) && value.startsWith("https://");
};

const hasNoWhitespace = (value: string): boolean => !/\s/.test(value);

const atLeastLength =
  (minimum: number) =>
  (value: string): boolean =>
    value.length >= minimum;

// The endpoint encodes the Cloudflare account id, which is why no separate account-id variable
// exists. Both faults seen in the wild are caught here: the whole `.env` line pasted into the
// value field, and a literal `<account-id>` left unsubstituted.
const R2_ENDPOINT_RULE: ValueRule = {
  expectation: "https://<32-hex-account-id>.r2.cloudflarestorage.com",
  accepts: (value) => /^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com\/?$/.test(value),
};

/**
 * The database each deployed environment is supposed to be talking to, stated here rather than
 * inferred from a connection string.
 *
 * A connection string's own path segment is the claim under test, not the evidence: Railway
 * production carried a `MIGRATION_DATABASE_URL` whose name and host both said staging, and every
 * check in the repository agreed with it because none of them asked the server. The value here is
 * what `current_database()` is compared against, so the comparison has an independent side.
 */
export const CANONICAL_DATABASE_NAME: Readonly<Record<DeployEnvironment, string>> = Object.freeze({
  preview: "lombakita_staging",
  production: "lombakita_production",
});

export const DEPLOY_ENV_KEY_SPECS: readonly DeployKeySpec[] = [
  {
    key: "DATABASE_URL",
    requiredIn: BOTH,
    rule: {
      expectation: "postgres://user:password@host/database",
      accepts: isPostgresConnectionUrl,
    },
  },
  // The migration role's connection, and the key whose absence from this list is why LAUNCH-D24
  // survived: the gate inspected DATABASE_URL and never looked at this one, so production's
  // migration credential pointed at the staging database and nothing in three layers could see it.
  //
  // THE SHAPE IS ALL THIS RULE CAN CATCH, and it is not the interesting half. A string naming
  // `lombakita_production` is accepted here whatever database it actually reaches; proving where it
  // lands needs a connection, which is the `migration-database` probe in connectors/status.ts.
  // Registering it here without that probe would restate the same false confidence one layer up.
  {
    key: "MIGRATION_DATABASE_URL",
    requiredIn: BOTH,
    rule: {
      expectation: "postgres://user:password@host/database",
      accepts: isPostgresConnectionUrl,
    },
  },
  {
    key: "AUTH_SECRET",
    requiredIn: BOTH,
    rule: { expectation: "at least 32 characters", accepts: atLeastLength(32) },
  },
  {
    key: "REDIS_URL",
    requiredIn: BOTH,
    rule: {
      expectation: "redis://host:port or rediss://host:port",
      accepts: isRedisConnectionUrl,
    },
  },
  {
    key: "MEILISEARCH_HOST",
    requiredIn: BOTH,
    rule: { expectation: "an absolute http(s) origin with no path", accepts: isHttpOrigin },
  },
  {
    key: "MEILISEARCH_API_KEY",
    requiredIn: BOTH,
    rule: { expectation: "an opaque key with no whitespace", accepts: hasNoWhitespace },
  },
  { key: "R2_ENDPOINT", requiredIn: BOTH, rule: R2_ENDPOINT_RULE },
  {
    key: "R2_BUCKET",
    requiredIn: BOTH,
    rule: {
      expectation: "a lowercase bucket name, 3-63 characters",
      accepts: (value) => /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value),
    },
  },
  {
    key: "R2_ACCESS_KEY_ID",
    requiredIn: BOTH,
    rule: { expectation: "32 hex characters", accepts: (value) => /^[0-9a-f]{32}$/.test(value) },
  },
  {
    key: "R2_SECRET_ACCESS_KEY",
    requiredIn: BOTH,
    rule: { expectation: "64 hex characters", accepts: (value) => /^[0-9a-f]{64}$/.test(value) },
  },
  {
    key: "RESEND_API_KEY",
    requiredIn: BOTH,
    rule: {
      expectation: "a Resend key beginning with re_",
      accepts: (value) => /^re_[A-Za-z0-9_-]{10,}$/.test(value),
    },
  },
  // Checked because the sender and the key must belong to the same Resend account, and preview and
  // production now use different ones. A sender whose domain is not verified on that account fails
  // every send with a 403 — invisible until someone tries to sign up. The shape is all this can
  // catch; that the domain is actually verified is proven by sending to a Resend simulator address.
  //
  // BARE ADDRESS ONLY. Resend also accepts `Display Name <address@domain>`, but the generic
  // placeholder check owns angle brackets and runs first, so that form is refused as an
  // unsubstituted placeholder before this rule is reached. Both environments use the bare form;
  // supporting the other one would mean exempting this key from the placeholder check, which trades
  // a real guard for a format nothing uses.
  {
    key: "AUTH_EMAIL_FROM",
    requiredIn: BOTH,
    rule: {
      expectation: "a bare email address, with no display name or angle brackets",
      accepts: (value) => /^[^\s<>@]+@[^\s<>@.]+\.[^\s<>@]+$/.test(value),
    },
  },
  // Preview derives its base URL from VERCEL_URL per deployment, so an absent value there is
  // correct rather than missing. Production pins the canonical apex.
  //
  // PRODUCTION ASSERTS THE VALUE, NOT THE SHAPE, and it is the only key here that does. Every
  // crawler-facing URL the platform emits — robots.txt's sitemap pointer, all 46 sitemap entries,
  // every canonical and Open Graph URL — is built from this one string. `https://example.com` is a
  // flawless https origin and would have sent an entire launch to someone else's domain, with no
  // check anywhere in the repository able to see it. Compared against CANONICAL_SITE_ORIGIN so the
  // address lives in one place beside the rest of the company's stated identity.
  {
    key: "APP_BASE_URL",
    requiredIn: PRODUCTION_ONLY,
    rule: {
      expectation: `an https origin with no path (in production, exactly ${CANONICAL_SITE_ORIGIN})`,
      accepts: (value, environment) =>
        environment === "production"
          ? value.replace(/\/+$/, "") === CANONICAL_SITE_ORIGIN
          : isHttpsOrigin(value),
    },
  },
  {
    key: "AUTH_URL",
    requiredIn: PRODUCTION_ONLY,
    rule: { expectation: "an https origin with no path", accepts: isHttpsOrigin },
  },
  {
    key: "NEXT_PUBLIC_APP_URL",
    requiredIn: NEITHER,
    rule: { expectation: "an https origin with no path", accepts: isHttpsOrigin },
  },
  // Optional by design: auth.config.ts registers GoogleProvider only when both are present, so a
  // missing pair silently removes the sign-in method rather than failing. Reported as a warning so
  // that silence is at least visible in the deploy log.
  {
    key: "GOOGLE_CLIENT_ID",
    requiredIn: NEITHER,
    rule: {
      expectation: "a Google client id ending in .apps.googleusercontent.com",
      accepts: (value) => value.endsWith(".apps.googleusercontent.com"),
    },
  },
  {
    key: "GOOGLE_CLIENT_SECRET",
    requiredIn: NEITHER,
    rule: { expectation: "an opaque secret with no whitespace", accepts: hasNoWhitespace },
  },
  // Shape is deliberately not checked here — probeSentry already owns the DSN format, and stating
  // it twice would put the same knowledge in two places. Listed so absence is reported.
  { key: "SENTRY_DSN", requiredIn: NEITHER },
  { key: "NEXT_PUBLIC_SENTRY_DSN", requiredIn: NEITHER },
  // AES-256-GCM key encrypting platform_ops/finance_ops TOTP secrets at rest — web
  // runtime only, never read by the Railway worker. Required in BOTH environments from day one:
  // unlike R2/Meilisearch/Resend, there is no local-development carve-out for this key, because an
  // absent key does not degrade a feature gracefully — it blocks every operational account from
  // ever reaching an admin surface. Shape check catches the same wrong-length mistake the probe's
  // round trip also catches, but cheaply and before any live check runs.
  {
    key: "MFA_SECRET_ENCRYPTION_KEY",
    requiredIn: BOTH,
    rule: {
      expectation: "32 raw bytes, base64-encoded (44 characters, base64 padding included)",
      accepts: (value) => {
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      },
    },
  },
];

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /<[^>\s]+>/,
  /\breplace[-_]me\b/i,
  /\bchange[-_]?me\b/i,
  /\bplaceholder\b/i,
  /\bTODO\b/,
];

const findPlaceholderToken = (value: string): string | null => {
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = pattern.exec(value);

    if (match) {
      return match[0];
    }
  }

  return null;
};

const isWrappedInQuotes = (value: string): boolean => {
  if (value.length < 2) {
    return false;
  }

  const first = value.at(0);
  const last = value.at(-1);

  return (first === '"' && last === '"') || (first === "'" && last === "'");
};

// Faults that are wrong for any variable, whatever it holds. Each corresponds to a copy-paste
// mistake that survives every presence check.
const findGenericValueProblem = (key: string, value: string): string | null => {
  if (value.startsWith(`${key}=`)) {
    return `value repeats its own variable name — the whole "${key}=…" line was pasted into the value field`;
  }

  if (value !== value.trim()) {
    return "value has leading or trailing whitespace";
  }

  if (isWrappedInQuotes(value)) {
    return "value is wrapped in quotes, so the quotes are part of the value";
  }

  const placeholder = findPlaceholderToken(value);

  if (placeholder) {
    return `value still contains the unsubstituted placeholder ${placeholder}`;
  }

  return null;
};

const findProblemForSpec = (
  spec: DeployKeySpec,
  environment: DeployEnvironment,
  rawValue: string | undefined,
): DeployConfigProblem | null => {
  const value = rawValue ?? "";

  if (value.length === 0) {
    const required = spec.requiredIn.includes(environment);

    return {
      key: spec.key,
      severity: required ? "error" : "warning",
      problem: required ? "not set" : "not set (optional)",
    };
  }

  const genericProblem = findGenericValueProblem(spec.key, value);

  if (genericProblem) {
    return { key: spec.key, severity: "error", problem: genericProblem };
  }

  if (spec.rule && !spec.rule.accepts(value, environment)) {
    return {
      key: spec.key,
      severity: "error",
      problem: `value does not look like ${spec.rule.expectation}`,
    };
  }

  return null;
};

export const findDeployConfigProblems = (
  env: Record<string, string | undefined>,
  environment: DeployEnvironment,
): DeployConfigProblem[] => {
  return DEPLOY_ENV_KEY_SPECS.map((spec) =>
    findProblemForSpec(spec, environment, env[spec.key]),
  ).filter((problem): problem is DeployConfigProblem => problem !== null);
};
