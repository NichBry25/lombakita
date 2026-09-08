/**
 * Detection rules for credentials committed as source text, plus the classification and
 * allowlist logic the scanner is built on. Pure and side-effect free so the runner's behaviour
 * is testable without a filesystem or a git repository.
 *
 * Two design constraints, both learned from the credential this file exists because of. It sat on
 * `main` in a public repository for 101 days.
 *
 * FIRST: rules key on the SHAPE OF A VALUE, never on the name of the variable holding it. The
 * exposed line read `const DB_URL = "postgresql://user:password@localhost:5432/lombakita"`. Two
 * separate scans keyed on `DATABASE_URL` and reported the file clean. A name is chosen by whoever
 * writes the leak, so a name is not something a detector may depend on.
 *
 * SECOND: a host is not a credential. `scripts/lib/local-database-host.ts` reads that same string
 * and returns true for "this is loopback, it is safe to write through", which is correct for the
 * question it asks and useless for this one. The password was valid against production while the
 * host was `localhost`. Nothing here may infer that a value is safe from where it points.
 */

import { createHash } from "node:crypto";

export type SecretRule = {
  readonly id: string;
  /** What a match means, printed with every finding so a reader need not open this file. */
  readonly description: string;
  readonly pattern: RegExp;
  /** Which capture group holds the secret itself. 0 means the whole match. */
  readonly secretGroup: number;
  /** Rebuilds the match for display with the secret portion masked. */
  readonly preview: (match: RegExpExecArray) => string;
};

export type Finding = {
  readonly ruleId: string;
  readonly description: string;
  readonly path: string;
  readonly line: number;
  readonly preview: string;
  readonly fingerprint: string;
};

export type AllowlistEntry = {
  readonly fingerprint: string;
  readonly rule: string;
  readonly preview: string;
  readonly reason: string;
};

/**
 * Masks a secret for display. Never prints enough to reconstruct the value: a report gets pasted
 * into chats and tickets, so the report itself must not become a second copy of the leak.
 */
export const maskSecret = (secret: string): string => {
  if (secret.length <= 8) {
    return `${"*".repeat(secret.length)} (len ${secret.length})`;
  }

  return `${secret.slice(0, 2)}${"*".repeat(secret.length - 2)} (len ${secret.length})`;
};

const shannonEntropy = (value: string): number => {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }

  return entropy;
};

const longestLowercaseRun = (value: string): number => {
  let longest = 0;
  let current = 0;

  for (const char of value) {
    if (char >= "a" && char <= "z") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }

  return longest;
};

/**
 * Whether a string of secret-plausible length and charset actually looks RANDOM rather than
 * like an identifier, a slug, or a path. Without this the entropy rule reports every long
 * camelCase function name in the repository and gets switched off within a day, which is the
 * ordinary way a scanner stops working.
 */
export const looksRandom = (value: string): boolean => {
  if (value.length < 24) return false;
  if (!/[0-9]/.test(value)) return false;
  if (!/[A-Za-z]/.test(value)) return false;

  // Identifier and slug shapes. These are the bulk of long strings in any codebase.
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value)) return false;
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(value)) return false;
  if (/^[A-Z0-9_]+$/.test(value)) return false;

  // camelCase is NOT matched with a regex here. The obvious one, /^[a-z]+([A-Z][a-zA-Z0-9]*)*$/,
  // matches a random key like "xJ8kQ2mZ4pR7nW1sT5vY9bL3cH6dF0gA" outright, because the trailing
  // [a-zA-Z0-9]* swallows everything after the first capital. That is a detector reporting a
  // secret as an identifier, which is the failure direction that matters.
  //
  // What separates the two is run length, not case pattern: identifiers are built from words, so
  // they carry long unbroken lowercase runs, and a random string almost never does. Five is
  // deliberately conservative. It accepts that a base64 value happening to hold five consecutive
  // lowercase letters is missed by THIS rule, which is a backstop; the provider prefix and URI
  // rules above do not depend on it. A false positive here would flag every long function name in
  // the repository and get the whole gate switched off, which costs more than the miss.
  if (longestLowercaseRun(value) >= 5) return false;

  // A path, unless it also carries base64 padding or a plus, which a path does not have.
  if (value.includes("/") && !/[+=]/.test(value)) return false;

  const distinctRatio = new Set(value).size / value.length;
  if (distinctRatio < 0.55) return false;

  return shannonEntropy(value) >= 4.0;
};

/**
 * Passwords that appear in this repository's local and CI fixtures by convention. Excluded at the
 * RULE level rather than through the allowlist file, because they recur in dozens of files and
 * every one of them would otherwise need its own entry, which trains a reader to approve entries
 * without reading them.
 */
const CONVENTIONAL_FIXTURE_PASSWORDS = new Set([
  "postgres",
  "password",
  "pass",
  "p",
  "pw",
  "secret",
  "test",
  "redis",
  "root",
  "admin",
  "user",
  "example",
  "changeme",
]);

const isPlaceholderValue = (value: string): boolean =>
  /^(<.*>|\$\{.*\}|\.\.\.|x{3,}|replace-with|your-|placeholder|dummy|redacted|changeme)/i.test(
    value,
  );

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: "uri-credential",
    description:
      "A connection URI carrying an inline password. This is the shape that leaked; it is matched " +
      "regardless of the variable name and regardless of whether the host is loopback.",
    pattern:
      /\b([a-z][a-z0-9+.-]{1,15}):\/\/([A-Za-z0-9._%-]{1,64}):([^\s"'`<>@/\\]{3,128})@([A-Za-z0-9._-]{2,128})/g,
    secretGroup: 3,
    preview: (m) => `${m[1]}://${m[2]}:${maskSecret(m[3] ?? "")}@${m[4]}`,
  },
  {
    id: "resend-api-key",
    description: "A Resend API key.",
    pattern: /\bre_[A-Za-z0-9]{4,}_[A-Za-z0-9]{16,}\b/g,
    secretGroup: 0,
    preview: (m) => maskSecret(m[0]),
  },
  {
    id: "aws-access-key-id",
    description: "An AWS access key id, which is also the R2 access key id shape.",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    secretGroup: 0,
    preview: (m) => maskSecret(m[0]),
  },
  {
    id: "google-oauth-client-secret",
    description: "A Google OAuth client secret.",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{16,}/g,
    secretGroup: 0,
    preview: (m) => maskSecret(m[0]),
  },
  {
    id: "stripe-secret-key",
    description: "A live Stripe secret or restricted key.",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g,
    secretGroup: 0,
    preview: (m) => maskSecret(m[0]),
  },
  {
    id: "github-token",
    description: "A GitHub personal access, OAuth, or installation token.",
    pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g,
    secretGroup: 0,
    preview: (m) => maskSecret(m[0]),
  },
  {
    id: "slack-token",
    description: "A Slack bot, user, or app token.",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    secretGroup: 0,
    preview: (m) => maskSecret(m[0]),
  },
  {
    id: "sendgrid-api-key",
    description: "A SendGrid API key.",
    pattern: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    secretGroup: 0,
    preview: (m) => maskSecret(m[0]),
  },
  {
    id: "xendit-secret-key",
    description: "A Xendit secret key.",
    pattern: /\bxnd_[a-z]+_[A-Za-z0-9_+=-]{20,}/g,
    secretGroup: 0,
    preview: (m) => maskSecret(m[0]),
  },
  {
    id: "private-key-block",
    description: "An inline PEM private key block.",
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
    secretGroup: 0,
    preview: () => "-----BEGIN PRIVATE KEY----- (block present)",
  },
  {
    id: "json-web-token",
    description: "A signed JSON Web Token, which may carry a long lived credential.",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    secretGroup: 0,
    preview: (m) => maskSecret(m[0]),
  },
  {
    id: "high-entropy-literal",
    description:
      "A quoted string that is long, random looking, and mixed charset. This is the catch-all " +
      "for a provider this file has no specific rule for.",
    pattern: /(['"`])([A-Za-z0-9+/=_-]{24,120})\1/g,
    secretGroup: 2,
    preview: (m) => maskSecret(m[2] ?? ""),
  },
] as const;

/**
 * Whether a matched value is exempt by its own content rather than by an allowlist decision.
 * Kept narrow on purpose: an exemption here is invisible in the report, so it may only cover
 * values that cannot be secrets at all.
 */
const isExemptValue = (rule: SecretRule, secret: string): boolean => {
  if (isPlaceholderValue(secret)) return true;

  if (rule.id === "uri-credential") {
    return CONVENTIONAL_FIXTURE_PASSWORDS.has(secret.toLowerCase());
  }

  if (rule.id === "high-entropy-literal") {
    // Subresource Integrity digests are random looking by construction and are published
    // deliberately. `package-lock.json` alone holds around three hundred, which would have been
    // the entire output of this gate and the reason someone turned it off.
    if (/^sha(?:1|256|384|512)-/.test(secret)) return true;

    return !looksRandom(secret);
  }

  return false;
};

/**
 * A fingerprint identifies a finding by rule and secret value, NOT by path or line. Moving a file
 * or editing the line above it must not silently drop an approved exemption back into the report,
 * and the same fixture value appearing in thirty test files is one decision, not thirty.
 */
export const fingerprintOf = (ruleId: string, secret: string): string =>
  createHash("sha256").update(`${ruleId}\n${secret}`).digest("hex").slice(0, 16);

export const scanText = (text: string, path: string): Finding[] => {
  const findings: Finding[] = [];

  // Precomputed so a match's offset becomes a line number without rescanning the file per match.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((lineStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  for (const rule of SECRET_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      // A zero-width match would spin forever. No rule should produce one, but a future rule
      // edit should fail loudly rather than hang a CI job.
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }

      const secret = rule.secretGroup === 0 ? match[0] : (match[rule.secretGroup] ?? "");
      if (secret.length === 0 || isExemptValue(rule, secret)) continue;

      findings.push({
        ruleId: rule.id,
        description: rule.description,
        path,
        line: lineOf(match.index),
        preview: rule.preview(match),
        fingerprint: fingerprintOf(rule.id, secret),
      });
    }
  }

  return findings;
};

export type AllowlistValidation = {
  readonly entries: readonly AllowlistEntry[];
  readonly errors: readonly string[];
};

/**
 * An allowlist entry is a person stating, in writing, that a specific value is not a secret.
 * An entry without a real reason is an unexplained hole in the gate, so it is rejected rather
 * than honoured. The length floor exists because "false positive" is not a reason.
 */
export const MINIMUM_REASON_LENGTH = 20;

export const validateAllowlist = (raw: unknown): AllowlistValidation => {
  const errors: string[] = [];

  if (
    raw === null ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { entries?: unknown }).entries)
  ) {
    return { entries: [], errors: ['allowlist must be an object with an "entries" array'] };
  }

  const entries: AllowlistEntry[] = [];
  const seen = new Set<string>();

  for (const [index, candidate] of (raw as { entries: unknown[] }).entries.entries()) {
    const where = `entries[${index}]`;

    if (candidate === null || typeof candidate !== "object") {
      errors.push(`${where}: must be an object`);
      continue;
    }

    const entry = candidate as Partial<AllowlistEntry>;

    if (typeof entry.fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(entry.fingerprint)) {
      errors.push(`${where}: "fingerprint" must be the 16 hex characters the scanner reports`);
      continue;
    }
    if (typeof entry.rule !== "string" || entry.rule.length === 0) {
      errors.push(`${where}: "rule" is required`);
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < MINIMUM_REASON_LENGTH) {
      errors.push(
        `${where}: "reason" must be at least ${MINIMUM_REASON_LENGTH} characters saying why this value is not a secret`,
      );
      continue;
    }
    if (seen.has(entry.fingerprint)) {
      errors.push(`${where}: duplicate fingerprint ${entry.fingerprint}`);
      continue;
    }

    seen.add(entry.fingerprint);
    entries.push({
      fingerprint: entry.fingerprint,
      rule: entry.rule,
      preview: typeof entry.preview === "string" ? entry.preview : "",
      reason: entry.reason,
    });
  }

  return { entries, errors };
};

export const applyAllowlist = (
  findings: readonly Finding[],
  entries: readonly AllowlistEntry[],
): { reported: Finding[]; suppressed: Finding[] } => {
  const allowed = new Set(entries.map((entry) => entry.fingerprint));
  const reported: Finding[] = [];
  const suppressed: Finding[] = [];

  for (const finding of findings) {
    if (allowed.has(finding.fingerprint)) suppressed.push(finding);
    else reported.push(finding);
  }

  return { reported, suppressed };
};

export type Classification = "text" | "declared-binary" | "unclassifiable";

/**
 * Extensions whose contents this scanner cannot read and does not need to. Every one of them is
 * a DECLARATION: the population this instrument covers is "every tracked file except these", and
 * that sentence is only true while this list is short and specific.
 */
export const DECLARED_BINARY_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".icns",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".zip",
  ".gz",
  ".mp4",
  ".webm",
  ".wasm",
] as const;

/**
 * Decides whether a file can be scanned. An input that is neither readable text nor a declared
 * binary is reported UNCLASSIFIABLE and fails the run. Skipping it instead would be fail-open,
 * and a gate that quietly narrows its own population is the failure this scanner was written
 * after: the existing deploy env gate covers declared env keys, so a credential in a source file
 * was never inside anything it could fail on.
 */
export const classifyContent = (bytes: Buffer, path: string): Classification => {
  const lower = path.toLowerCase();
  const isDeclaredBinary = DECLARED_BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));

  const probe = bytes.subarray(0, 8000);
  const hasNulByte = probe.includes(0);

  if (hasNulByte) return isDeclaredBinary ? "declared-binary" : "unclassifiable";

  // A file with no NUL byte still has to decode before a regex can read it. Validity is decided by
  // a fatal decoder, NOT by searching the decoded text for U+FFFD. Searching for the replacement
  // character misreads any file that legitimately CONTAINS one as undecodable, which this file
  // does: the first version of this check spelled the character as a literal and then classified
  // itself as unclassifiable, which would have failed CI on the commit that introduced it.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return isDeclaredBinary ? "declared-binary" : "unclassifiable";
  }

  return "text";
};

/**
 * Env files must never be tracked. `.example` templates are the intended exception and are
 * scanned like any other text file, so a real value pasted into one is still caught.
 */
export const isForbiddenEnvPath = (path: string): boolean => {
  const name = path.split("/").pop() ?? path;
  if (!name.startsWith(".env")) return false;

  return !name.endsWith(".example") && !name.endsWith(".sample") && !name.endsWith(".template");
};
