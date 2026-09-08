/**
 * Every address a fixture, seed or script can hand to the email provider, declared as data.
 *
 * EMAIL-D4 specified the simulator addresses and nothing enforced it, so the incident recurred four
 * days after the first one. Specification without enforcement is the failure being closed here: this
 * module is the subject declaration, and the test beside it is the gate.
 *
 * Two ways an address is acceptable and no third:
 *   - it sits at a reserved TLD, so it can never route anywhere and the send boundary refuses it
 *     before the provider is called;
 *   - it is one of Resend's simulator addresses, which route to the provider on purpose and produce
 *     a known outcome without touching a person.
 *
 * The reserved list is IMPORTED from the production guard rather than restated. If a TLD is ever
 * added or removed there, this gate follows it; a second copy would drift and start disagreeing with
 * the thing it is supposed to describe.
 *
 * Rule 38: this refuses what it cannot classify. An address that is neither reserved nor a simulator
 * fails the gate even if it is obviously harmless, because "obviously harmless" is a judgement the
 * gate is not able to make and skipping it is how the population silently stops being covered.
 */

import { readFileSync } from "node:fs";
import { RESERVED_RECIPIENT_TLDS } from "../../src/server/email/reserved-recipients";

/**
 * Resend's simulator mailboxes.
 *
 * `delivered@` and `bounced@` ONLY. `complained@resend.dev` is deliberately absent: a complaint is
 * recorded against the sending domain's reputation the same way a real one is, which is the exact
 * harm this whole line of work exists to prevent.
 */
export const SIMULATOR_RECIPIENTS = Object.freeze([
  "delivered@resend.dev",
  "bounced@resend.dev",
] as const);

/**
 * The files whose recipients this gate governs.
 *
 * An explicit list rather than a directory walk: a walk silently covers whatever happens to be on
 * disk, so a new fixture directory would be neither covered nor reported. The test asserts each of
 * these exists, so a rename fails loudly instead of quietly shrinking the population.
 */
export const GOVERNED_FIXTURE_FILES = Object.freeze([
  "scripts/testing/seeds.mjs",
  "scripts/testing/api-matrix.mjs",
  "scripts/testing/flows.mjs",
  "scripts/testing/pages.mjs",
  "scripts/testing/ui-states.mjs",
  "scripts/testing/r2-flows.mjs",
  "scripts/testing/probes/worker-send-attempt.ts",
  "scripts/seed-test-matrix.ts",
  "scripts/retention/r2-retention.ts",
  "scripts/concurrency/mfa-factor-races.ts",
  "scripts/concurrency/upgrade-owner-cap.ts",
  "scripts/concurrency/finance-idempotency-races.ts",
  "scripts/concurrency/competition-participation.ts",
  "scripts/concurrency/verification-cas-races.ts",
  "scripts/concurrency/institution-verification-submission.ts",
  "scripts/concurrency/registration-document-request.ts",
  "src/server/scripts/seed-step-4.5-saves.ts",
  "src/server/scripts/verify-step-4.5-saved-cap.ts",
] as const);

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export type FixtureRecipient = {
  file: string;
  line: number;
  address: string;
  verdict: "reserved" | "simulator" | "routable";
};

/**
 * The reserved TLD an address sits under, or null when it routes.
 *
 * Mirrors the production `reservedTldOf` deliberately rather than importing it: that one is the
 * runtime guard and takes a single address at the send boundary, while this reads text that may not
 * be an address at all. Keeping the traversal here lets the gate stay a pure text instrument, and
 * the LIST both consult is the shared thing that matters.
 */
const reservedTldOf = (address: string): string | null => {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const tld = domain.slice(domain.lastIndexOf(".") + 1);

  return (RESERVED_RECIPIENT_TLDS as readonly string[]).includes(tld) ? tld : null;
};

/**
 * Whether a match is a connection string's credentials rather than a recipient.
 *
 * `postgres://user:pass@host/db` matches the same shape as an address. This is a CLASSIFICATION, not
 * a skip: the token is identified as a URL authority by the scheme that precedes it on the line, and
 * anything not so identified is still held to the recipient rule.
 */
const isUrlAuthority = (line: string, index: number): boolean =>
  line.slice(0, index).includes("://");

/** Every address-shaped token in one file, each with its verdict. */
export const scanFixtureFile = (file: string): FixtureRecipient[] => {
  const lines = readFileSync(file, "utf8").split("\n");
  const found: FixtureRecipient[] = [];

  lines.forEach((line, offset) => {
    for (const match of line.matchAll(EMAIL_PATTERN)) {
      const address = match[0];
      if (isUrlAuthority(line, match.index)) continue;

      const verdict = (SIMULATOR_RECIPIENTS as readonly string[]).includes(address.toLowerCase())
        ? "simulator"
        : reservedTldOf(address) !== null
          ? "reserved"
          : "routable";

      found.push({ file, line: offset + 1, address, verdict });
    }
  });

  return found;
};

/** Every governed file's recipients, in one list. */
export const scanGovernedFixtures = (): FixtureRecipient[] =>
  GOVERNED_FIXTURE_FILES.flatMap((file) => scanFixtureFile(file));
