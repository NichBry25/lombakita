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
  | "sensitive-unmirrored";

export type OverlayReportEntry = { name: OverlayName; status: OverlayStatus };

type EnvMap = Readonly<Record<string, string | undefined>>;

const isOverlayName = (name: string): boolean =>
  (OVERLAY_NAMES as readonly string[]).includes(name);

const BLOCKING_STATUSES: readonly OverlayStatus[] = ["drift", "unwritable", "sensitive-unmirrored"];

/**
 * The only values the overlay will write: printable ASCII with no space, and none of the
 * characters that either parser reading the pulled file (Node's loadEnvFile in the gate steps,
 * dotenv inside `vercel build`) would treat differently inside single quotes.
 */
export const isWritableMirrorValue = (value: string): boolean =>
  /^[\x21-\x7E]+$/.test(value) && !/['"`\\$]/.test(value);

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

  return { merged, report };
};

/**
 * Names outside the nine whose pulled value is the placeholder. The overlay cannot fill them, so
 * they are only reported; layer 1 decides whether the missing value matters.
 */
export const findSensitivePlaceholdersOutsideOverlay = (pulledEnv: EnvMap): string[] =>
  Object.entries(pulledEnv)
    .filter(([name, value]) => value === SENSITIVE_PLACEHOLDER && !isOverlayName(name))
    .map(([name]) => name);

export const hasBlockingOverlayStatus = (report: readonly OverlayReportEntry[]): boolean =>
  report.some((entry) => BLOCKING_STATUSES.includes(entry.status));
