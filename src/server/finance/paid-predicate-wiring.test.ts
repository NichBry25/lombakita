// @vitest-environment node
//
// EACH PAID PREDICATE IS USED BY THE CORRECT GUARD.
//
// The two predicates answer different questions and fire at different moments (see
// paid-registration.ts). Because both are booleans about "has this been paid", swapping them
// compiles, type-checks, and passes every test that does not specifically look — while moving the
// DEC-0132 unpublish block later than the moment it exists to cover, or making DEC-0131's
// non-refundable rule bind before any money has arrived.
//
// This file asserts the WIRING, at the source, because there is no runtime signal that
// distinguishes a correct pairing from a swapped one.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), "utf8").replace(/\s*\n\s*/g, " ");

/**
 * The same source with comments stripped.
 *
 * Required for the negative assertions specifically. These modules EXPLAIN why they do not branch
 * on `registration_type` and why row existence is not the predicate — so a prose-inclusive scan
 * matches the explanation and reports the defect it was written to rule out. Stripping comments is
 * what makes "this identifier does not appear" a statement about the code.
 */
const readCode = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\s*\n\s*/g, " ");

/**
 * The source of ONE exported function, comment-stripped, from its declaration to the next one.
 *
 * Whole-file substring checks cannot tell the two predicates apart: swap their bodies and every
 * identifier is still present somewhere in the file, so the scan stays green while the DEC-0132
 * block fires on the wrong moment. Slicing per function is what makes a body swap visible.
 */
const functionBody = (relative: string, name: string): string => {
  const source = readCode(relative);
  const start = source.indexOf(`export const ${name} =`);
  if (start === -1) throw new Error(`${name} not found in ${relative}`);
  const rest = source.slice(start + name.length);
  const next = rest.indexOf("export const ");
  return next === -1 ? rest : rest.slice(0, next);
};

const PREDICATES = "src/server/finance/paid-registration.ts";
const COMPETITION_SERVICE = "src/server/competitions/competition-service.ts";
const FEE_SERVICE = "src/server/competitions/competition-fee-service.ts";
const REGISTRATION_SERVICE = "src/server/registrations/registration-service.ts";

describe("paid predicates are defined once, distinctly", () => {
  it("exports both predicates as separately named functions", () => {
    const source = read(PREDICATES);

    expect(source).toContain("export const isRegistrationConfirmedPaid");
    expect(source).toContain("export const isRegistrationPaymentInFlight");
    expect(source).toContain("export const hasCompetitionPaymentInFlight");
  });

  it("defines the payment group once and uses it for both predicates", () => {
    const source = read(PREDICATES);

    expect(source).toContain("export const resolvePaymentGroupRegistrationIds");
    // One definition, not one per predicate.
    expect(source.match(/const resolvePaymentGroupRegistrationIds/g)).toHaveLength(1);
  });

  it("never branches the payment group on registration_type", () => {
    // A team registration is N rows sharing team_id; the group is defined by team_id alone. Reading
    // registration_type instead is how one mode acquires a code path the other never exercises.
    const source = readCode(PREDICATES);

    expect(source).not.toContain("registrationType");
    expect(source).not.toContain("registration_type");
  });

  it("filters on a positive gross amount — row existence is not the predicate", () => {
    // `finance_payments` accepts gross = 0, so a FREE registration can carry a payment row. A
    // predicate that only checks for a row reports every free registration as paid.
    const source = read(PREDICATES);

    expect(source).toContain("gt(financePayments.grossAmount, 0)");
  });

  it("prices the COMPETITION-level predicate too, in its own body", () => {
    // This one does not go through the payment group, so the shared filter above says nothing about
    // it. Without its own join it reduced to "a proof row exists", and a single proof against a
    // zero-gross payment would block a free competition's unpublish forever.
    const body = functionBody(PREDICATES, "hasCompetitionPaymentInFlight");

    expect(body).toContain("financePayments");
    expect(body).toContain("gt(financePayments.grossAmount, 0)");
  });

  it("derives confirmed-paid by FOLDING events, never by reading a status column", () => {
    const source = read(PREDICATES);

    expect(source).toContain("foldPaymentEvents");
    expect(source).toContain('status === "succeeded"');
  });

  it("keeps each predicate's own mechanism in its own body — a swap is visible here", () => {
    // Both are booleans about "has this been paid", so exchanging their bodies compiles, type-checks
    // and leaves every whole-file substring check green. These assertions are per function, which is
    // what makes that swap fail.
    const confirmed = functionBody(PREDICATES, "isRegistrationConfirmedPaid");
    const inFlight = functionBody(PREDICATES, "isRegistrationPaymentInFlight");

    // Confirmed paid folds the EVENT stream and knows nothing about proof review states.
    expect(confirmed).toContain("foldPaymentEvents");
    expect(confirmed).not.toContain("IN_FLIGHT_PROOF_STATUSES");

    // In flight reads the PROOF's review state and never folds events.
    expect(inFlight).toContain("IN_FLIGHT_PROOF_STATUSES");
    expect(inFlight).not.toContain("foldPaymentEvents");
  });
});

describe("the DEC-0132 unpublish block uses PAYMENT IN FLIGHT", () => {
  it("calls hasCompetitionPaymentInFlight, not the confirmed-paid predicate", () => {
    // In flight fires EARLIER than confirmed-paid. The dangerous window is precisely the one where
    // a candidate has transferred real rupiah and the organiser has not verified it yet — the
    // narrower predicate would let exactly that case through.
    const source = readCode(COMPETITION_SERVICE);

    expect(source).toContain("hasCompetitionPaymentInFlight(competitionId, tx)");
    expect(source).toContain("competition_unpublish_blocked_payment_in_flight");
    expect(source).not.toContain("isRegistrationConfirmedPaid");
  });

  it("runs the block BEFORE the registration cancellation it protects against", () => {
    const source = read(COMPETITION_SERVICE);

    const guardAt = source.indexOf("competition_unpublish_blocked_payment_in_flight");
    const cancelAt = source.indexOf("INSTITUTION_CANCELLATION_REASON,");

    expect(guardAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeGreaterThan(-1);
    // A guard that runs after the cascade has already cancelled everyone protects nobody.
    expect(guardAt).toBeLessThan(cancelAt);
  });
});

describe("the fee-setting write path enforces the edit matrix THROUGH the classifier", () => {
  // The in-flight and free-entrants rules used to be written out a second time in this service,
  // next to the copies in `classifyCompetitionEdit`. These assertions pinned the DUPLICATES, so
  // they passed precisely because the duplication existed and would have gone on passing while the
  // two copies drifted apart. What matters now is that there is ONE statement of the matrix and
  // that this path reaches it — the refusals themselves are proven behaviourally against a real
  // database in manual-lane-db.integration.test.ts, which is where a rule that stopped firing
  // would actually be caught.
  it("routes through classifyCompetitionEdit rather than restating the matrix", () => {
    const source = read(FEE_SERVICE);

    expect(source).toContain("classifyCompetitionEdit(");
    expect(source).toContain("loadEditClassificationSnapshot(");
  });

  it("keeps no private copy of either matrix rule", () => {
    const source = read(FEE_SERVICE);

    // A local re-check is how one path ends up permitting what the shared rule refuses. Both of
    // these predicates belong to the classifier's snapshot now, and calling either directly here
    // would be the duplication returning.
    expect(source).not.toContain("hasCompetitionPaymentInFlight(");
    expect(source).not.toContain("hasActiveFreeRegistrations(");
  });

  it("gates charging and fee resolution on the SAME shared guards, not private copies", () => {
    const source = read(FEE_SERVICE);

    // A second, lighter verification check written locally is how one path ends up permitting what
    // the shared guard refuses.
    expect(source).toContain("assertInstitutionVerified(competition.institutionId, db)");
    expect(source).toContain("requireFeeRuleInForce(competition.institutionId, now, db)");
    expect(source).toContain("requirePaymentInstructions(competition.institutionId, db)");
  });
});

describe("DEC-0131's non-refundable rule is the confirmed-paid question", () => {
  it("still refuses candidate self-cancellation on a paid competition", () => {
    // What must hold is that the rule keys off the competition being priced, through the ONE shared
    // helper rather than a local parse.
    const source = readCode(REGISTRATION_SERVICE);

    expect(source).toContain("isPaidCompetition(competition.feeAmount)");
    expect(source).toContain("cancellation_not_supported_for_paid");
    // The private byte-identical copy is gone.
    expect(source).not.toContain("Number.parseFloat(feeAmount)");
  });
});

describe("the wiring scan is not vacuous", () => {
  it("reads real, non-trivial sources", () => {
    // Every assertion above is a substring check; if a path were wrong, `read` would throw, but a
    // file that had been emptied would silently satisfy every `not.toContain`.
    for (const path of [PREDICATES, COMPETITION_SERVICE, FEE_SERVICE, REGISTRATION_SERVICE]) {
      expect(read(path).length, path).toBeGreaterThan(500);
    }
  });
});
