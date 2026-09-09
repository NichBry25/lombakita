// NO FIXTURE MAY MAIL A PERSON.
//
// EMAIL-D4 said this already. Nothing enforced it, and the incident recurred four days later, which
// is why the deliverable here is the gate rather than the migration. A seed run with delivery
// enabled hands every fixture recipient to the provider; addresses that cannot route become hard
// bounces, and a run of hard bounces is what costs a sending domain its reputation.
//
// The gate refuses anything it cannot classify (Rule 38), across two populations that are each
// proved complete. ONE walk of the repository with an explicit deny list feeds both, so no file
// falls between them and no directory is in scope only because somebody remembered to name it.
// Send-capable programs must each be governed or exempted, and a reverse check proves the walk
// still reaches everything already governed — narrowing the walk makes the forward check pass more
// easily, so the forward check alone is not enough. Unit tests pin their routable addresses per
// file under a total-count ratchet, because a per-entry list lets the register grow invisibly.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  ACCEPTED_ROUTABLE_TEST_ADDRESSES,
  EXEMPT_SEND_CAPABLE_FILES,
  GOVERNED_FIXTURE_FILES,
  PINNED_ADDRESS_CEILING,
  SIMULATOR_RECIPIENTS,
  WALK_DENIED_DIRECTORIES,
  discoverSendCapableFiles,
  discoverTestFiles,
  partitionWalkedFiles,
  pinnedAddressTotal,
  scanFixtureFile,
  scanGovernedFixtures,
  scanGovernedTestFiles,
  walkRepositoryFiles,
} from "./fixture-recipients";

describe("the governed fixture population", () => {
  it("names files that all still exist", () => {
    // A renamed fixture must fail here rather than silently leave the population.
    for (const file of GOVERNED_FIXTURE_FILES) {
      expect(existsSync(file), `${file} is governed but missing`).toBe(true);
    }
  });

  it("actually finds recipients, so a green result means something was measured", () => {
    // A scanner that matched nothing would pass every assertion below while covering nothing.
    expect(scanGovernedFixtures().length).toBeGreaterThan(20);
  });

  // THE COMPLETENESS ASSERTION. Every check above this one asks whether the declared files are
  // clean; none of them asks whether the declaration covers the class it claims to. It did not:
  // the first run of this test named three address-bearing scripts nobody had declared.
  it("declares every address-bearing file that can actually send", () => {
    const declared = new Set<string>([
      ...GOVERNED_FIXTURE_FILES,
      ...EXEMPT_SEND_CAPABLE_FILES.map((entry) => entry.file),
    ]);

    const undeclared = discoverSendCapableFiles().filter((file) => !declared.has(file));

    expect(
      undeclared,
      "These files carry an address and can hand it to the provider, but the gate does not " +
        "govern them. Add each to GOVERNED_FIXTURE_FILES, or to EXEMPT_SEND_CAPABLE_FILES with " +
        "the reason on the row. Leaving one undeclared is the fail-open this assertion exists " +
        "to stop.",
    ).toEqual([]);
  });

  // THE OTHER HALF OF COMPLETENESS, and the one that makes the deny list itself checked. The
  // assertion above only asks whether what discovery FINDS is declared, so narrowing the walk makes
  // it pass more easily — a deny list that swallowed half the repository would look like success.
  // This asks the reverse: everything already governed must still be reachable by the walk.
  it("walks every file it already governs, so the deny list cannot hide one", () => {
    const walked = new Set(partitionWalkedFiles(walkRepositoryFiles()).sendCapable);

    const unreachable = GOVERNED_FIXTURE_FILES.filter((file) => !walked.has(file));

    expect(
      unreachable,
      "These files are governed but the repository walk no longer reaches them, so the " +
        "completeness assertion above has stopped covering them. A denied directory or a " +
        "narrowed extension list is the usual cause.",
    ).toEqual([]);
  });

  it("denies directories by name only, each with a reason", () => {
    // A path here would silently match nothing, because the walk compares directory NAMES.
    for (const entry of WALK_DENIED_DIRECTORIES) {
      expect(entry.file, `${entry.file} is a path, not a directory name`).not.toContain("/");
      expect(entry.reason.length, `${entry.file} is denied without a reason`).toBeGreaterThan(10);
    }
  });

  it("names exemptions that all still exist, so a rename cannot retire one silently", () => {
    for (const entry of EXEMPT_SEND_CAPABLE_FILES) {
      expect(existsSync(entry.file), `${entry.file} is exempted but missing`).toBe(true);
      expect(entry.reason.length, `${entry.file} is exempted without a reason`).toBeGreaterThan(20);
    }
  });
});

describe("the unit-test population", () => {
  const routableInTests = scanGovernedTestFiles();

  it("is discovered by walking the repository, so a new test file is covered without being declared", () => {
    // BREADTH FIRST, then depth. If the walk collapsed — a denied directory too broad, an
    // extension list narrowed — every assertion below would pass over almost nothing and read as
    // success, so the population's size is asserted before anything is concluded from its contents.
    const { sendCapable, tests } = partitionWalkedFiles(walkRepositoryFiles());

    expect(sendCapable.length, "send-capable candidates").toBeGreaterThan(300);
    expect(tests.length, "test candidates").toBeGreaterThan(200);
    expect(discoverTestFiles().length, "tests carrying a routable address").toBeGreaterThan(25);
  });

  it("carries no routable address that is not pinned for its file", () => {
    const pinned = new Map(
      ACCEPTED_ROUTABLE_TEST_ADDRESSES.map((entry) => [entry.file, new Set(entry.addresses)]),
    );

    const unpinned = routableInTests
      .filter((found) => !pinned.get(found.file)?.has(found.address))
      .map((found) => `${found.file}:${found.line} → ${found.address}`);

    expect(
      unpinned,
      "A routable address appeared in a test file that does not declare it. Prefer a reserved " +
        "address (@seed.lombakita.local). Pin it in ACCEPTED_ROUTABLE_TEST_ADDRESSES only when " +
        "the domain itself is what the assertion measures.",
    ).toEqual([]);
  });

  it("pins nothing that has already been cleaned up", () => {
    // Without this the register rots: an address converted to a reserved one would leave its pin
    // behind, and the pin would go on excusing that address if it ever came back.
    const live = new Set(routableInTests.map((found) => `${found.file} ${found.address}`));

    const stale = ACCEPTED_ROUTABLE_TEST_ADDRESSES.flatMap((entry) =>
      entry.addresses
        .filter((address) => !live.has(`${entry.file} ${address}`))
        .map((address) => `${entry.file} → ${address}`),
    );

    expect(stale, "Pinned but no longer present. Remove the entry.").toEqual([]);
  });

  // THE RATCHET. The two assertions above are each satisfied by an address added to an existing
  // entry — it is pinned, so not unpinned; it is live, so not stale — which is how the register
  // grew silently by one edit. This is the only check that sees the register's SIZE.
  it("holds exactly the debt the ceiling declares, so growth cannot hide inside an entry", () => {
    expect(
      pinnedAddressTotal(),
      `The pinned register holds ${pinnedAddressTotal()} addresses but PINNED_ADDRESS_CEILING ` +
        `says ${PINNED_ADDRESS_CEILING}. Going UP means a new routable fixture was accepted: ` +
        "prefer converting it to @seed.lombakita.local or a simulator address. Going DOWN means " +
        "debt was paid — lower the ceiling in the same commit so it can never come back.",
    ).toBe(PINNED_ADDRESS_CEILING);
  });
});

describe("every fixture recipient", () => {
  const routable = scanGovernedFixtures().filter((found) => found.verdict === "routable");

  it("is reserved or a simulator address, never routable", () => {
    const offenders = routable.map((found) => `${found.file}:${found.line} → ${found.address}`);

    expect(
      offenders,
      "A routable fixture recipient can reach a real inbox and bounce against the sending " +
        "domain. Use a reserved TLD, or a Resend simulator address where a real send must be " +
        `exercised: ${SIMULATOR_RECIPIENTS.join(", ")}.`,
    ).toEqual([]);
  });
});

describe("the classifier the gate depends on", () => {
  it("reads Resend's simulator mailboxes as simulator, not as routable", () => {
    // resend.dev IS routable, deliberately. Without this branch the gate would forbid the very
    // addresses it is supposed to steer people towards.
    for (const address of SIMULATOR_RECIPIENTS) {
      // The module that DECLARES them, which is where the literals live now that the connector
      // probe sends to the same constant from production code.
      const [found] = scanFixtureFile("src/server/email/simulator-recipients.ts").filter(
        (candidate) => candidate.address === address,
      );
      expect(found?.verdict, `${address} misclassified`).toBe("simulator");
    }
  });

  it("does not carry complained@resend.dev, which harms the sending domain like a real complaint", () => {
    expect(SIMULATOR_RECIPIENTS as readonly string[]).not.toContain("complained@resend.dev");
  });

  it("classifies a connection string's credentials as a URL authority, not as a recipient", () => {
    // `postgres://user:pass@host/db` matches the address shape. Identifying it is a classification
    // and the verdict is RECORDED: the authority appears in the output rather than disappearing
    // from it, so a reader can see what the scanner decided instead of inferring it from a gap.
    //
    // Rows 5-6 are the line-scope regression: asking whether `://` appeared anywhere earlier on the
    // line let one connection string excuse every address after it.
    //
    // Rows 7-9 are the token-scope regression that replaced it. A URL's query, path and fragment
    // are all part of the same whitespace-delimited token as its scheme, so scoping to the token
    // still excused a real recipient sitting in any of them — the shape a webhook URL has. Only the
    // AUTHORITY belongs to the URL's credentials, and it ends at the first / ? or #.
    const found = scanFixtureFile("scripts/testing/fixtures/recipient-shapes.txt");

    expect(found.map((f) => `${f.address}:${f.verdict}`)).toEqual([
      "seed.person@seed.lombakita.local:reserved",
      "delivered@resend.dev:simulator",
      "secret@ep-example.ap-southeast-1.aws.neon.tech:url_authority",
      "real.person@gmail.com:routable",
      "secret@db.internal:url_authority",
      "second.person@gmail.com:routable",
      "third.person@gmail.com:routable",
      "fourth.person@gmail.com:routable",
      "fifth.person@gmail.com:routable",
    ]);
  });
});
