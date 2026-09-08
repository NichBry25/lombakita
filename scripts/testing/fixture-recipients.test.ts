// NO FIXTURE MAY MAIL A PERSON.
//
// EMAIL-D4 said this already. Nothing enforced it, and the incident recurred four days later, which
// is why the deliverable here is the gate rather than the migration. A seed run with delivery
// enabled hands every fixture recipient to the provider; addresses that cannot route become hard
// bounces, and a run of hard bounces is what costs a sending domain its reputation.
//
// The gate governs an explicitly declared file list and refuses anything it cannot classify
// (Rule 38). It does not walk directories: a walk covers whatever happens to be on disk, so a new
// fixture file would be neither covered nor reported, and the gate would keep reporting green over
// a population it had stopped describing.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  GOVERNED_FIXTURE_FILES,
  SIMULATOR_RECIPIENTS,
  scanFixtureFile,
  scanGovernedFixtures,
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
      const [found] = scanFixtureFile("scripts/testing/fixture-recipients.ts").filter(
        (candidate) => candidate.address === address,
      );
      expect(found?.verdict, `${address} misclassified`).toBe("simulator");
    }
  });

  it("does not carry complained@resend.dev, which harms the sending domain like a real complaint", () => {
    expect(SIMULATOR_RECIPIENTS as readonly string[]).not.toContain("complained@resend.dev");
  });

  it("classifies a connection string's credentials as a URL authority, not as a recipient", () => {
    // `postgres://user:pass@host/db` matches the address shape. Identifying it is a classification;
    // silently skipping unmatched text would be the fail-open this gate exists to avoid.
    const found = scanFixtureFile("scripts/testing/fixtures/recipient-shapes.txt");

    expect(found.map((f) => `${f.address}:${f.verdict}`)).toEqual([
      "seed.person@seed.lombakita.local:reserved",
      "delivered@resend.dev:simulator",
      "real.person@gmail.com:routable",
    ]);
  });
});
