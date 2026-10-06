/**
 * Which deploy-gate variables are mirrored in GitHub, and how a mirrored value merges with what
 * `vercel pull` returned.
 *
 * A Sensitive Vercel variable is not returned by `vercel pull`: CLI 56 writes an empty string
 * (INFRA-D1), CLI 62 writes SENSITIVE_PLACEHOLDER. Either blinds every step that reads the pulled
 * file. The nine secrets are therefore also stored as write-only GitHub environment secrets, and
 * the overlay step fills the pulled file from them before the gate runs.
 *
 * Pure and dependency-free so it can be unit-tested against fixture records. The report carries
 * names and statuses only; a value never leaves this module except inside `merged`.
 */

export const OVERLAY_NAMES = [
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "AUTH_SECRET",
  "REDIS_URL",
  "MEILISEARCH_API_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "RESEND_API_KEY",
  "MFA_SECRET_ENCRYPTION_KEY",
] as const;

/** Required by the gate, not secret, and never mirrored: Vercel's plain value is authoritative. */
export const PLAIN_REQUIRED_NAMES = [
  "R2_ENDPOINT",
  "R2_BUCKET",
  "MEILISEARCH_HOST",
  "AUTH_EMAIL_FROM",
  "APP_BASE_URL",
  "AUTH_URL",
] as const;

export type OverlayName = (typeof OVERLAY_NAMES)[number];

/** What CLI 62 writes for a Sensitive variable. Public, not a secret; matched as the whole value. */
export const SENSITIVE_PLACEHOLDER = "[SENSITIVE]";

export type OverlayStatus =
  | "filled-from-github"
  | "equal"
  | "drift"
  | "not-mirrored"
  | "unset"
  | "unwritable"
  | "sensitive-unmirrored"
  | "sensitive-public-placeholder";

export type OverlayReportEntry = { name: string; status: OverlayStatus };

type EnvMap = Readonly<Record<string, string | undefined>>;

const isOverlayName = (name: string): boolean =>
  (OVERLAY_NAMES as readonly string[]).includes(name);

/** Next.js compiles every variable with this prefix into the browser bundle at build time. */
const PUBLIC_PREFIX = "NEXT_PUBLIC_";

const isPublicName = (name: string): boolean => name.startsWith(PUBLIC_PREFIX);

const BLOCKING_STATUSES: readonly OverlayStatus[] = [
  "drift",
  "unwritable",
  "sensitive-unmirrored",
  "sensitive-public-placeholder",
];

/**
 * The only values the overlay will write: printable ASCII with no space, and none of the
 * characters that either parser reading the pulled file (Node's loadEnvFile in the gate steps,
 * dotenv inside `vercel build`) would treat differently inside single quotes. The placeholder is
 * excluded by value: a GitHub secret holding it would "fill" a name with the very string the
 * overlay exists to replace.
 */
export const isWritableMirrorValue = (value: string): boolean =>
  value !== SENSITIVE_PLACEHOLDER && /^[\x21-\x7E]+$/.test(value) && !/['"`\\$]/.test(value);

const classify = (pulled: string, mirror: string): OverlayStatus => {
  if (mirror !== "" && !isWritableMirrorValue(mirror)) {
    return "unwritable";
  }

  if (mirror !== "" && (pulled === "" || pulled === SENSITIVE_PLACEHOLDER)) {
    return "filled-from-github";
  }

  if (pulled === SENSITIVE_PLACEHOLDER) {
    return "sensitive-unmirrored";
  }

  if (pulled === "") {
    return "unset";
  }

  if (mirror === "") {
    return "not-mirrored";
  }

  return pulled === mirror ? "equal" : "drift";
};

export const overlayDeployEnv = (
  pulledEnv: EnvMap,
  mirror: EnvMap,
): { merged: Record<string, string | undefined>; report: OverlayReportEntry[] } => {
  const merged: Record<string, string | undefined> = { ...pulledEnv };
  const report: OverlayReportEntry[] = [];

  for (const name of OVERLAY_NAMES) {
    const status = classify(pulledEnv[name] ?? "", mirror[name] ?? "");

    if (status === "filled-from-github") {
      merged[name] = mirror[name];
    }

    report.push({ name, status });
  }

  for (const name of findSensitivePublicPlaceholders(pulledEnv)) {
    report.push({ name, status: "sensitive-public-placeholder" });
  }

  return { merged, report };
};

/**
 * `NEXT_PUBLIC_` names whose pulled value is the placeholder. They are compiled into the client
 * bundle, so the placeholder would ship to every browser; the overlay refuses the run.
 */
export const findSensitivePublicPlaceholders = (pulledEnv: EnvMap): string[] =>
  Object.entries(pulledEnv)
    .filter(([name, value]) => value === SENSITIVE_PLACEHOLDER && isPublicName(name))
    .map(([name]) => name);

/**
 * Other names outside the nine whose pulled value is the placeholder. The overlay cannot fill
 * them, so they are only reported. The gate does not verify them either: layer 1 has no rule that
 * rejects the placeholder for server-only optional names such as GOOGLE_CLIENT_SECRET or SENTRY_DSN.
 */
export const findSensitivePlaceholdersOutsideOverlay = (pulledEnv: EnvMap): string[] =>
  Object.entries(pulledEnv)
    .filter(
      ([name, value]) =>
        value === SENSITIVE_PLACEHOLDER && !isOverlayName(name) && !isPublicName(name),
    )
    .map(([name]) => name);

export const hasBlockingOverlayStatus = (report: readonly OverlayReportEntry[]): boolean =>
  report.some((entry) => BLOCKING_STATUSES.includes(entry.status));
