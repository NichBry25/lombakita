/**
 * Every address a fixture, seed or script can hand to the email provider, declared as data.
 *
 * EMAIL-D4 specified the simulator addresses and nothing enforced it, so the incident recurred four
 * days after the first one. Specification without enforcement is the failure being closed here: this
 * module is the subject declaration, and the test beside it is the gate.
 *
 * In a file that can actually send, two ways an address is acceptable and no third:
 *   - it sits at a reserved TLD, so it can never route anywhere and the send boundary refuses it
 *     before the provider is called;
 *   - it is one of Resend's simulator addresses, which route to the provider on purpose and produce
 *     a known outcome without touching a person.
 *
 * Both lists are IMPORTED from production rather than restated. The reserved names come from the
 * send guard, and the simulator addresses from the module the connector probe also sends to. If
 * either set changes there, this gate follows it; a second copy would drift and start disagreeing
 * with the thing it is supposed to describe.
 *
 * Rule 38: this refuses what it cannot classify. An address that is neither reserved nor a simulator
 * fails the gate even if it is obviously harmless, because "obviously harmless" is a judgement the
 * gate is not able to make and skipping it is how the population silently stops being covered.
 *
 * TWO POPULATIONS, EACH COMPLETE, EACH WITH ITS OWN RULE. Send-capable programs are declared in
 * `GOVERNED_FIXTURE_FILES` and discovered against `SEND_CAPABLE_PATTERNS`, so a file that is neither
 * governed nor exempted fails. Unit tests are discovered by pattern alone and hold their routable
 * addresses on a pinned per-file list that can only shrink. Asking a single question of both would have meant
 * either forcing rewrites that invert what a classifier test measures, or the state this replaces,
 * where the whole test tree was outside the gate and nothing said so.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reservedRecipientSuffixOf } from "../../src/server/email/reserved-recipients";
import { SIMULATOR_RECIPIENTS } from "../../src/server/email/simulator-recipients";

export { SIMULATOR_RECIPIENTS };

/**
 * The files whose recipients this gate governs.
 *
 * An explicit list rather than a directory walk, so a rename fails loudly instead of quietly
 * shrinking the population — but an explicit list alone answers "are the declared files clean?"
 * and never "is the declaration complete?". `SEND_CAPABLE_PATTERNS` below supplies the second half:
 * discovery finds every address-bearing file in this class, and a file it finds that is not
 * declared here fails the gate. Three were found the first time it ran.
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
  "scripts/finance/clear-local-finance-residue.ts",
  "scripts/testing/probes/config-gates.mjs",
] as const);

/**
 * Where a file that can hand an address to the provider is allowed to live.
 *
 * These are programs that RUN: seeds, harnesses, concurrency drivers, one-off scripts. A unit test
 * is a different population with a different rule, declared further down.
 */
export type FilePattern = {
  root: string;
  suffix: string;
};

export const SEND_CAPABLE_PATTERNS: readonly FilePattern[] = Object.freeze([
  { root: "scripts", suffix: ".ts" },
  { root: "scripts", suffix: ".mjs" },
  { root: "src/server/scripts", suffix: ".ts" },
] as const);

export type DeclaredExemption = {
  file: string;
  reason: string;
};

/**
 * Send-capable files deliberately held outside the recipient rule, each with the reason on the row.
 *
 * A declaration, not a skip: the file is named, the reason is reviewable, and anything discovered
 * that is neither governed nor declared here fails. The distinction matters because the previous
 * version of this gate had no third state at all, so a file it did not know about was simply
 * invisible rather than refused.
 */
export const EXEMPT_SEND_CAPABLE_FILES: readonly DeclaredExemption[] = Object.freeze([
  {
    file: "scripts/testing/fixture-recipients.ts",
    reason:
      "the declaration itself. It holds the pinned addresses of every other file, so it is " +
      "address-bearing by construction and sends nothing",
  },
  {
    file: "scripts/testing/probes/fixture-recipients.mjs",
    reason:
      "the Rule 36 probe for this gate. It plants a routable address in a governed file to show " +
      "the gate goes red, so the address is the probe's payload and governing the probe would " +
      "make the gate fail on its own evidence",
  },
] as const);

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export type FixtureRecipient = {
  file: string;
  line: number;
  address: string;
  verdict: "reserved" | "simulator" | "url_authority" | "routable";
};

/**
 * Characters that end an address-shaped token. Everything between two of these is one token, which
 * is the unit a URL scheme can belong to.
 */
const TOKEN_BOUNDARY = /[\s"'`,;()[\]{}<>\\]/;

/**
 * Whether a match is a connection string's credentials rather than a recipient.
 *
 * `postgres://user:pass@host/db` matches the same shape as an address. This is a CLASSIFICATION and
 * never a skip: the caller records the verdict, so a URL authority stays visible in the scan output
 * instead of vanishing from it. A token that is not identified as one is still held to the
 * recipient rule.
 *
 * SCOPED TO THE TOKEN, not to the line. Asking whether `://` appears anywhere earlier on the line
 * meant one connection string excused every address after it, so a line carrying a database URL and
 * a real recipient reported only the URL and passed. The scheme is only this token's if it sits
 * inside this token, which is what walking back to the nearest boundary establishes.
 */
const isUrlAuthority = (line: string, index: number): boolean => {
  let start = index;

  while (start > 0 && !TOKEN_BOUNDARY.test(line[start - 1]!)) {
    start -= 1;
  }

  return line.slice(start, index).includes("://");
};

/** Every address-shaped token in one file, each with its verdict. */
export const scanFixtureFile = (file: string): FixtureRecipient[] => {
  const lines = readFileSync(file, "utf8").split("\n");
  const found: FixtureRecipient[] = [];

  lines.forEach((line, offset) => {
    for (const match of line.matchAll(EMAIL_PATTERN)) {
      const address = match[0];

      const verdict = isUrlAuthority(line, match.index)
        ? "url_authority"
        : (SIMULATOR_RECIPIENTS as readonly string[]).includes(address.toLowerCase())
          ? "simulator"
          : // The production guard itself, not a copy of it. An earlier copy here restated only the
            // TLD half and would have gone on calling example.com routable after the guard stopped.
            reservedRecipientSuffixOf(address) !== null
            ? "reserved"
            : "routable";

      found.push({ file, line: offset + 1, address, verdict });
    }
  });

  return found;
};

/**
 * The unit-test population. Discovered by pattern, so it is complete by construction.
 *
 * These files were outside the gate entirely until now, which is how nineteen addresses at a real
 * consumer mail domain sat in them unreported. A unit test mocks the provider and mails nobody, so
 * the rule here is weaker than the send-capable one — but "weaker" has to mean a declared list that
 * can only shrink, not an absent one.
 */
export const GOVERNED_TEST_PATTERNS: readonly FilePattern[] = Object.freeze([
  { root: "src", suffix: ".test.ts" },
  // The send-capable discovery skips `.test.ts`, so without this pattern a test file under
  // scripts/ would sit between the two populations and be governed by neither.
  { root: "scripts", suffix: ".test.ts" },
] as const);

/**
 * Why a routable address in a test file is accepted. Two reasons and no third.
 *
 * `domain_under_test` — the address's DOMAIN is what the assertion is about: the reserved-recipient
 * classifier, the corporate-versus-personal email flags, the sender-shape rules. Rewriting these to
 * a reserved TLD would not make the test safer, it would invert what it measures.
 *
 * `mocked_delivery` — an ordinary fixture in a test that never reaches the send boundary. These are
 * the ones worth converting over time, and every conversion shortens this list.
 */
export type RoutableTestAddressReason = "domain_under_test" | "mocked_delivery";

export type AcceptedRoutableTestFile = {
  file: string;
  addresses: readonly string[];
  reason: RoutableTestAddressReason;
};

/**
 * The routable addresses each governed test file is allowed to carry, pinned per file.
 *
 * PINNED RATHER THAN SKIPPED, the same shape as ACCEPTED_DIVERGENCES in the drift check. A file on
 * this list is still scanned and still has to present exactly these addresses; a new one is a
 * failure. The list is a debt register that can only shrink, and a file that leaves it cannot come
 * back without a review.
 */
export const ACCEPTED_ROUTABLE_TEST_ADDRESSES: readonly AcceptedRoutableTestFile[] = Object.freeze([
  {
    // The gate's own test. These are the expected verdicts of the classifier, so each address is
    // the subject of an assertion about how it should be read.
    file: "scripts/testing/fixture-recipients.test.ts",
    addresses: [
      "complained@resend.dev",
      "real.person@gmail.com",
      "second.person@gmail.com",
      "secret@db.internal",
      "secret@ep-example.ap-southeast-1.aws.neon.tech",
    ],
    reason: "domain_under_test",
  },
  {
    file: "src/app/api/platform-ops/users/lookup/route.test.ts",
    addresses: ["a@b.com", "missing@b.com"],
    reason: "mocked_delivery",
  },
  {
    file: "src/app/api/v1/auth/verify-role/route.test.ts",
    addresses: ["rendra@corp.co.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/app/api/v1/recruiter/me/verification/route.test.ts",
    addresses: ["wisnu@perusahaan.co.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/config/env-email-delivery.test.ts",
    addresses: ["noreply@mail.lombakita.com"],
    reason: "domain_under_test",
  },
  {
    file: "src/config/env-shape.test.ts",
    addresses: [
      "noreply@auth.lombakita.com",
      "noreply@mail.lombakita.com",
      "noreply@preview-auth.lombakita.com",
      "ops@lombakita.com",
    ],
    reason: "domain_under_test",
  },
  {
    file: "src/config/unowned-domain.test.ts",
    addresses: ["dukungan@lombakita.com"],
    reason: "domain_under_test",
  },
  {
    file: "src/server/async/jobs/invitation-dispatch.test.ts",
    addresses: ["x@e.com"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/async/jobs/notification-dual-write.test.ts",
    addresses: ["a@test.com", "b@test.com", "user@test.com"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/async/jobs/notification-workers.test.ts",
    addresses: ["a@test.com", "b@test.com", "user@test.com"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/async/jobs/payment-notification-jobs.test.ts",
    addresses: [
      "a@test.com",
      "captain@test.com",
      "m2@test.com",
      "m3@test.com",
      "m4@test.com",
      "owner@test.com",
      "staff@test.com",
    ],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/auth/auth-config-live-role.test.ts",
    addresses: ["a@b.com"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/auth/auth-config-suspension.test.ts",
    addresses: ["a@b.com"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/auth/credentials-auth-signup.test.ts",
    addresses: ["dinda@corp.co.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/auth/credentials-auth.test.ts",
    addresses: [
      "Dinda@Campus.AC.ID",
      "Rendra@Corp.CO.ID",
      "dinda@campus.ac.id",
      "rendra@corp.co.id",
    ],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/auth/credentials-claim-wiring.test.ts",
    addresses: ["user@e.com"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/auth/oauth-account.test.ts",
    addresses: ["attacker@corp.co.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/auth/register-takeover-guard.test.ts",
    addresses: ["rendra@corp.co.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/auth/role-verification-db.test.ts",
    addresses: ["rendra@corp.co.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/email/delivery.test.ts",
    addresses: ["a@b.com", "auth@lombakita.com"],
    reason: "domain_under_test",
  },
  {
    file: "src/server/email/reserved-recipients.test.ts",
    addresses: [
      "a@example.co.id",
      "a@examples.com",
      "a@notexample.com",
      "a@sub.domain.co.id",
      "candidate@gmail.com",
      "ops@lombakita.com",
      "user@my.test.com",
      "user@testing.com",
      "x@localhost.com",
    ],
    reason: "domain_under_test",
  },
  {
    file: "src/server/email/send-failure.test.ts",
    addresses: ["noreply@mail.lombakita.com"],
    reason: "domain_under_test",
  },
  {
    file: "src/server/institution-invitations/invitation-service.test.ts",
    addresses: ["nobody@e.com", "x@e.com"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/institution-verification/submission-service.test.ts",
    addresses: ["alice@company.co.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/institution-verification/verification-requirements.test.ts",
    addresses: [
      "dosen@ui.ac.id",
      "mahasiswa@its.ac.id",
      "user@GMAIL.COM",
      "user@UI.AC.ID",
      "user@company.co.id",
      "user@gmail.com",
    ],
    reason: "domain_under_test",
  },
  {
    file: "src/server/institution-verification/verification-service.test.ts",
    addresses: ["owner@contoh.ac.id", "owner@contoh.co.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/institution-workspace/institution-profile-core.test.ts",
    addresses: ["panitia@kampus.ac.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/institution-workspace/institution-public-service.test.ts",
    addresses: ["budi@kampus.ac.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/invitations/invite-resolution.test.ts",
    addresses: [
      "Owner@B.com",
      "a@b.com",
      "claim@b.com",
      "nobody@b.com",
      "owner@b.com",
      "team-claim@b.com",
    ],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/moderation/lookup-service.test.ts",
    addresses: ["a@b.com", "owner@b.com", "rektor@nusantara.ac.id"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/recruiter-verification/recruiter-verification-core.test.ts",
    addresses: ["Rendra@Corp.CO.ID", "rendra@corp.co.id", "rendra@gmail.com"],
    reason: "domain_under_test",
  },
  {
    file: "src/server/recruiter-verification/recruiter-verification-service.test.ts",
    addresses: ["r@corp.co"],
    reason: "mocked_delivery",
  },
  {
    file: "src/server/teams/team-service.test.ts",
    addresses: ["fourth@y.io", "x@y.io"],
    reason: "mocked_delivery",
  },
] as const);

/**
 * Every file under `root` whose name ends in `suffix`, walked recursively.
 *
 * A walk rather than a shell glob so the discovery runs identically under vitest, under node and on
 * whatever CI image is current. What it finds is never trusted as the declaration — it is the thing
 * the declaration is checked against.
 */
const filesMatching = (pattern: FilePattern): string[] =>
  readdirSync(pattern.root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(pattern.suffix))
    .map((entry) => join(pattern.root, entry));

/** Every address-bearing file matched by a pattern set, in sorted order. */
export const discoverAddressBearingFiles = (patterns: readonly FilePattern[]): string[] => {
  const files = [...new Set(patterns.flatMap(filesMatching))].sort();

  return files.filter((file) =>
    scanFixtureFile(file).some((found) => found.verdict !== "url_authority"),
  );
};

/** Every routable address in the governed unit-test population. */
export const scanGovernedTestFiles = (): FixtureRecipient[] =>
  discoverAddressBearingFiles(GOVERNED_TEST_PATTERNS).flatMap((file) =>
    scanFixtureFile(file).filter((found) => found.verdict === "routable"),
  );

/** Every governed file's recipients, in one list. */
export const scanGovernedFixtures = (): FixtureRecipient[] =>
  GOVERNED_FIXTURE_FILES.flatMap((file) => scanFixtureFile(file));
