// NO FIXTURE MAY MAIL A PERSON.
//
// EMAIL-D4 said this already. Nothing enforced it, and the incident recurred four days later, which
// is why the deliverable here is the gate rather than the migration. A seed run with delivery
// enabled hands every fixture recipient to the provider; addresses that cannot route become hard
// bounces, and a run of hard bounces is what costs a sending domain its reputation.
//
// The gate refuses anything it cannot classify (Rule 38), across two populations that are each
// proved complete. Send-capable programs are named in an explicit list, so a rename fails loudly
// rather than quietly leaving the population — and a discovery pass then checks that list covers
// every address-bearing file in the class, because an explicit list on its own says nothing about
// what it omits. Unit tests are discovered by pattern and pin their routable addresses per file.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  ACCEPTED_ROUTABLE_TEST_ADDRESSES,
  EXEMPT_SEND_CAPABLE_FILES,
  GOVERNED_FIXTURE_FILES,
  GOVERNED_TEST_PATTERNS,
  SEND_CAPABLE_PATTERNS,
  SIMULATOR_RECIPIENTS,
  discoverAddressBearingFiles,
  scanFixtureFile,
  scanGovernedFixtures,
  scanGovernedTestFiles,
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

    const undeclared = discoverAddressBearingFiles(SEND_CAPABLE_PATTERNS).filter(
      (file) => !declared.has(file) && !file.endsWith(".test.ts"),
    );

    expect(
      undeclared,
      "These files carry an address and can hand it to the provider, but the gate does not " +
        "govern them. Add each to GOVERNED_FIXTURE_FILES, or to EXEMPT_SEND_CAPABLE_FILES with " +
        "the reason on the row. Leaving one undeclared is the fail-open this assertion exists " +
        "to stop.",
    ).toEqual([]);
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

  it("is discovered by pattern, so a new test file is covered without being declared", () => {
    // The property that makes this population complete. If discovery stopped matching, every
    // assertion below would pass over nothing, so the scan is proved non-empty first.
    expect(GOVERNED_TEST_PATTERNS.length).toBeGreaterThan(0);
    expect(discoverAddressBearingFiles(GOVERNED_TEST_PATTERNS).length).toBeGreaterThan(50);
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

  it("pins nothing that has already been cleaned up, so the list can only shrink", () => {
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
    // The last two rows are the line-scope regression. Asking whether `://` appeared anywhere
    // earlier on the line let one connection string excuse every address after it, so this line
    // reported the URL alone and the recipient beside it was never classified.
    const found = scanFixtureFile("scripts/testing/fixtures/recipient-shapes.txt");

    expect(found.map((f) => `${f.address}:${f.verdict}`)).toEqual([
      "seed.person@seed.lombakita.local:reserved",
      "delivered@resend.dev:simulator",
      "secret@ep-example.ap-southeast-1.aws.neon.tech:url_authority",
      "real.person@gmail.com:routable",
      "secret@db.internal:url_authority",
      "second.person@gmail.com:routable",
    ]);
  });
});
