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
 * TWO POPULATIONS, EACH COMPLETE, EACH WITH ITS OWN RULE. Both come from ONE walk of the repository
 * with an explicit deny list, so a file cannot fall between them and no directory is in scope only
 * because somebody remembered to name it. Send-capable programs must each be governed or exempted,
 * and the reverse check proves the walk still reaches everything already governed. Unit tests pin
 * their routable addresses per file under a total-count ratchet. Asking a single question of both
 * would have meant either forcing rewrites that invert what a classifier test measures, or the
 * state this replaces, where the whole test tree was outside the gate and nothing said so.
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
 * Directories the walk does not enter, and the reason each is out of the population.
 *
 * A DENY LIST WALKED FROM THE REPOSITORY ROOT, not an allow list of roots. The previous version
 * named `scripts` and `src/server/scripts` and so had exactly the defect it was written to close,
 * one level up: the roots were themselves an undeclared list, and a seed placed in any other
 * directory was invisible. That was demonstrated — a file at `src/server/seeds/` carrying a real
 * routable address passed the whole gate green.
 *
 * Everything not denied is in scope, so adding a directory to the repository adds it to the
 * population automatically. Removing one from the population is an edit here, with a reason, in a
 * diff — which is the property an allow list cannot have.
 */
export const WALK_DENIED_DIRECTORIES: readonly DeclaredExemption[] = Object.freeze([
  { file: "node_modules", reason: "dependencies, not this repository's code" },
  { file: ".git", reason: "object store" },
  { file: ".next", reason: "build output" },
  { file: ".vercel", reason: "build output" },
  { file: "coverage", reason: "test output" },
  { file: "dist", reason: "build output" },
  { file: "build", reason: "build output" },
  {
    file: "docs",
    reason:
      "a separate git repository (DEC-0101) holding prose, not programs. Nothing under it is " +
      "imported or executed by the application",
  },
] as const);

/**
 * File extensions that can execute a send in this repository.
 *
 * The one remaining allow list, and it is on a different axis from the roots that were removed: a
 * `.md` or a `.json` cannot call the provider. `.test.ts` is excluded from THIS population because
 * it belongs to the unit-test population below, which has its own rule.
 */
export const SEND_CAPABLE_EXTENSIONS: readonly string[] = Object.freeze([
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
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
    file: "src/server/email/simulator-recipients.ts",
    reason:
      "the simulator declaration. It names complained@resend.dev in prose precisely to record that " +
      "it is EXCLUDED, so the one routable address in the file is there to keep it out of use",
  },
  {
    file: "src/config/company.ts",
    reason:
      "the platform's own support address, which is a contact shown to users and a sender, never " +
      "a recipient a fixture hands to the provider. It is routable on purpose",
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
 * is the unit a URL can occupy.
 */
const TOKEN_BOUNDARY = /[\s"'`,;()[\]{}<>\\]/;

/** What ends a URL's authority and begins its path, query or fragment (RFC 3986 §3.2). */
const AUTHORITY_END = /[/?#]/;

/**
 * Whether a match is a URL's credentials rather than a recipient.
 *
 * `postgres://user:pass@host/db` matches the same shape as an address. This is a CLASSIFICATION and
 * never a skip: the caller records the verdict, so a URL authority stays visible in the scan output
 * instead of vanishing from it. A token that is not identified as one is still held to the
 * recipient rule.
 *
 * SCOPED TO THE AUTHORITY, not to the token and not to the line. Two earlier versions were wrong in
 * the same direction, each excusing more than it should:
 *   - asking whether `://` appeared anywhere earlier on the LINE let one connection string excuse
 *     every address after it, so a line carrying a database URL and a real recipient reported the
 *     URL alone;
 *   - asking whether `://` appeared anywhere earlier in the TOKEN still excused
 *     `https://host/send?to=victim@gmail.com`, because the query is part of the same token.
 *
 * A URL's authority ends at the first `/`, `?` or `#`. An address after that point is in the path
 * or the query — it is an address that happens to sit inside a URL, not the URL's own credentials,
 * and it is exactly the shape a webhook or an API call puts a real recipient into.
 *
 * Widening TOKEN_BOUNDARY to include `/ ? # = & :` looks like the same fix and is not: `:` sits
 * immediately before the password in `scheme://user:pass@host`, so the walk back terminates before
 * it ever reaches `://` and EVERY connection string reclassifies as a routable recipient. That
 * turns every seed's credentials into a finding and invites someone to pin them as accepted
 * addresses.
 */
const isUrlAuthority = (line: string, index: number): boolean => {
  let start = index;

  while (start > 0 && !TOKEN_BOUNDARY.test(line[start - 1]!)) {
    start -= 1;
  }

  const token = line.slice(start, index);
  const scheme = token.lastIndexOf("://");

  if (scheme === -1) {
    return false;
  }

  return !AUTHORITY_END.test(token.slice(scheme + 3));
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

const TEST_SUFFIX = ".test.ts";

const DENIED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(
  WALK_DENIED_DIRECTORIES.map((entry) => entry.file),
);

/**
 * Every file under `directory`, recursively, skipping the denied directories.
 *
 * Pruned DURING the walk rather than filtered after it: `node_modules` is large enough that
 * descending into it and discarding the result afterwards is the difference between a gate that
 * runs in CI and one nobody waits for.
 */
const walkRepository = (directory: string): string[] => {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (DENIED_DIRECTORY_NAMES.has(entry.name)) continue;
      found.push(...walkRepository(join(directory, entry.name)));
      continue;
    }

    if (entry.isFile()) {
      found.push(join(directory, entry.name));
    }
  }

  return found;
};

/** Repository-relative paths of every file the walk reaches, in sorted order. */
export const walkRepositoryFiles = (): string[] =>
  walkRepository(".")
    .map((file) => (file.startsWith("./") ? file.slice(2) : file))
    .sort();

/** The two populations, split out of one walk so no file can fall between them. */
export const partitionWalkedFiles = (
  files: readonly string[],
): { sendCapable: string[]; tests: string[] } => {
  const candidates = files.filter((file) =>
    SEND_CAPABLE_EXTENSIONS.some((extension) => file.endsWith(extension)),
  );

  return {
    sendCapable: candidates.filter((file) => !file.endsWith(TEST_SUFFIX)),
    tests: candidates.filter((file) => file.endsWith(TEST_SUFFIX)),
  };
};

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
 * failure. Its total size is held against PINNED_ADDRESS_CEILING below, so accepting one more
 * address is an edit to a stated number rather than a line added inside an entry, and paying debt
 * down forces that number lower in the same commit.
 */
export const ACCEPTED_ROUTABLE_TEST_ADDRESSES: readonly AcceptedRoutableTestFile[] = Object.freeze([
  {
    // The gate's own test. These are the expected verdicts of the classifier, so each address is
    // the subject of an assertion about how it should be read.
    file: "scripts/testing/fixture-recipients.test.ts",
    addresses: [
      "complained@resend.dev",
      "fifth.person@gmail.com",
      "fourth.person@gmail.com",
      "real.person@gmail.com",
      "second.person@gmail.com",
      "third.person@gmail.com",
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
 * Which of `files` carry at least one ROUTABLE address.
 *
 * Routable specifically, not address-bearing generally. A file whose only addresses are reserved or
 * simulator ones already satisfies the recipient rule, so demanding a declaration for it would add
 * no safety and a great deal of noise — and a list nobody reads is a list that gets rubber-stamped.
 * The moment such a file gains a routable address it becomes undeclared and the gate fails, which is
 * the trigger that matters.
 *
 * What discovery finds is never trusted as the declaration — it is the thing the declaration is
 * checked against.
 */
export const carryingRoutableAddress = (files: readonly string[]): string[] =>
  files.filter((file) => scanFixtureFile(file).some((found) => found.verdict === "routable"));

/** Every send-capable file in the repository carrying a routable address, found by walking it. */
export const discoverSendCapableFiles = (): string[] =>
  carryingRoutableAddress(partitionWalkedFiles(walkRepositoryFiles()).sendCapable);

/** Every test file in the repository carrying a routable address, found by the same walk. */
export const discoverTestFiles = (): string[] =>
  carryingRoutableAddress(partitionWalkedFiles(walkRepositoryFiles()).tests);

/** Every routable address in the governed unit-test population. */
export const scanGovernedTestFiles = (): FixtureRecipient[] =>
  discoverTestFiles().flatMap((file) =>
    scanFixtureFile(file).filter((found) => found.verdict === "routable"),
  );

/**
 * The ratchet. Total pinned addresses across every entry, which may go DOWN and never up.
 *
 * A per-entry list makes a new pin invisible: an address added to an existing `addresses` array
 * satisfies both the "no unpinned address" and the "no stale pin" assertions, so the register grew
 * silently. That was demonstrated — adding one address to one entry passed all eleven checks.
 *
 * WHAT THIS DOES AND DOES NOT ENFORCE, stated plainly because the previous wording did not. It
 * cannot make growth impossible: the number below is editable like any other. What it does is move
 * growth out of a fifty-entry array and onto a single line that says how much debt exists, so
 * raising it is a deliberate one-line act a reviewer sees, and paying debt down forces it lower.
 * The exact-equality assertion is what forces the second half.
 *
 * A LITERAL, NOT A SUM OVER THE REGISTER. Deriving it from the thing it bounds would make the
 * assertion true by construction and measure nothing, which is the defect this whole gate exists
 * to avoid shipping.
 */
export const PINNED_ADDRESS_CEILING = 83;

/** What the register actually holds right now. Compared against the literal above. */
export const pinnedAddressTotal = (): number =>
  ACCEPTED_ROUTABLE_TEST_ADDRESSES.reduce((total, entry) => total + entry.addresses.length, 0);

/** Every governed file's recipients, in one list. */
export const scanGovernedFixtures = (): FixtureRecipient[] =>
  GOVERNED_FIXTURE_FILES.flatMap((file) => scanFixtureFile(file));
