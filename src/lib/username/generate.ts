import { RESERVED_WORDS } from "@/lib/username/reserved-words";

/**
 * Username auto-generation.
 *
 * Produces `firstname_lastname_NNNN` style handles at account creation. The
 * token separator is an underscore — NOT a hyphen — because the locked username
 * validation rule (`platform-domain-contract.yaml` `username_handle.validation`
 * and `parseUsername` in `profile-core.ts`) only permits lowercase alphanumerics
 * and underscores. A generated username must itself be a valid, editable
 * username, so the prompt's `firstname-lastname-NNNN` example is realised with
 * underscores here. This is an intentional, contract-driven choice.
 *
 * Suffix strategy: a random 4-digit number (1000–9999). Random — not sequential —
 * because a sequential suffix would require a count/scan query per attempt and
 * would leak registration volume; the bounded collision loop handles the rare
 * suffix clash.
 */

const RESERVED = new Set(RESERVED_WORDS.map((word) => word.toLowerCase()));

const USERNAME_MIN = 3;
const USERNAME_MAX = 30;
const SUFFIX_MIN = 1000;
const SUFFIX_MAX = 9999;
const DEFAULT_MAX_ATTEMPTS = 20;
// The suffix renders as `_NNNN` (5 chars); cap the name base so `base_NNNN`
// always fits within the 30-char username ceiling.
const MAX_BASE_LENGTH = USERNAME_MAX - 5;

// Unicode combining-diacritical-marks block (U+0300–U+036F). After NFKD
// decomposition, stripping this range folds accented Latin letters to ASCII.
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/**
 * Thrown when the bounded retry loop is exhausted without finding a free,
 * non-reserved username. Recoverable: the account-creation handler catches it,
 * logs it, and surfaces a clean error rather than crashing the signup flow.
 */
export class UsernameGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsernameGenerationError";
  }
}

/**
 * Normalises a first/last name pair into a username base (no numeric suffix).
 *
 * - Unicode is NFKD-normalised and combining diacritics are stripped, so Latin
 *   accents fold to ASCII (e.g. `Ärjuna` -> `arjuna`).
 * - Any remaining non-`[a-z0-9]` character is replaced with `_`.
 * - Consecutive underscores are collapsed; leading/trailing underscores stripped.
 * - The base is truncated so the final `base_NNNN` username fits within 30 chars.
 * - If nothing usable remains, falls back to `user`.
 *
 * Deferred consideration: non-Latin scripts (CJK, Arabic, Cyrillic, etc.) have no
 * ASCII decomposition under NFKD and are dropped rather than transliterated — a
 * name written entirely in such a script degrades to the `user` fallback.
 * Transliteration is out of scope for this step.
 */
export const normalizeUsernameBase = (firstName: string, lastName: string): string => {
  const raw = `${firstName ?? ""} ${lastName ?? ""}`;
  let base = raw
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (base.length > MAX_BASE_LENGTH) {
    base = base.slice(0, MAX_BASE_LENGTH).replace(/_+$/g, "");
  }

  return base.length > 0 ? base : "user";
};

const randomNumericSuffix = (): string => {
  return String(Math.floor(Math.random() * (SUFFIX_MAX - SUFFIX_MIN + 1)) + SUFFIX_MIN);
};

/** Returns `true` when `candidate` is free (not already taken by another user). */
export type UsernameAvailabilityCheck = (candidate: string) => Promise<boolean>;

export type GenerateUsernameInput = {
  firstName: string;
  lastName: string;
  /** Uniqueness probe against the users table — supplied by the caller. */
  isAvailable: UsernameAvailabilityCheck;
  /** Bounded retry ceiling. Defaults to 20. */
  maxAttempts?: number;
  /** Injectable suffix source for deterministic tests. Defaults to a random 4-digit suffix. */
  suffixGenerator?: () => string;
};

/**
 * Generates a unique, reserved-word-safe username.
 *
 * Each attempt builds `base_NNNN`, skips it if it matches a reserved word, and
 * skips it if `isAvailable` reports it taken — returning the first candidate that
 * clears both checks. Throws {@link UsernameGenerationError} if `maxAttempts` is
 * exhausted without a free slot.
 */
export const generateUsername = async ({
  firstName,
  lastName,
  isAvailable,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  suffixGenerator = randomNumericSuffix,
}: GenerateUsernameInput): Promise<string> => {
  const base = normalizeUsernameBase(firstName, lastName);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const suffix = suffixGenerator();
    const candidate = (suffix ? `${base}_${suffix}` : base).replace(/_+$/g, "");

    if (candidate.length < USERNAME_MIN || candidate.length > USERNAME_MAX) {
      continue;
    }
    if (RESERVED.has(candidate)) {
      continue;
    }
    // Sequential by design: each probe must reflect rows committed by earlier
    // attempts within the same caller transaction. The loop is bounded.
    if (await isAvailable(candidate)) {
      return candidate;
    }
  }

  throw new UsernameGenerationError(
    `Could not generate a unique username after ${maxAttempts} attempts`,
  );
};
