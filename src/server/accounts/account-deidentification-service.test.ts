// @vitest-environment node
//
// The parts of the de-identification service that decide something without a database: the body
// shape the route admits, the exact set of storage prefixes the action deletes under, and the order
// the writing transaction takes its two locks in.
//
// The storage list is asserted here rather than only through the integration suite because the one
// claim that matters most about it is a claim about ABSENCE — `payment-proofs/` must never appear —
// and absence is what a prefix list quietly stops satisfying when a later edit adds a twelfth
// entry. Everything below names a literal prefix, so an edit that changes one is a failure here and
// not a deletion that reached further than it was told to.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeidentificationError,
  deidentificationObjectPrefixes,
  parseDeidentifyInput,
  type DeidentifyAccountInput,
} from "./account-deidentification-service";

const USER = "user-1";
const INSTITUTION = "inst-1";

const SERVICE = "src/server/accounts/account-deidentification-service.ts";

/**
 * The service's source with its comments removed.
 *
 * Comments are stripped because the ordering asserted below is EXPLAINED in prose in the file, and
 * prose naming both calls satisfies a whole-file scan for them — a scan that reads comments measures
 * the explanation rather than the code.
 */
const readServiceCode = (): string =>
  readFileSync(resolve(process.cwd(), SERVICE), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\s*\n\s*/g, " ");

describe("parseDeidentifyInput", () => {
  it("accepts an object carrying both strings", () => {
    const input: DeidentifyAccountInput = parseDeidentifyInput({
      confirmUsername: "target_user",
      reason: "permintaan melalui email",
    });

    expect(input).toEqual({ confirmUsername: "target_user", reason: "permintaan melalui email" });
  });

  it.each([null, undefined, "text", 7, ["confirmUsername", "reason"]])(
    "refuses %s as a body",
    (payload) => {
      expect(() => parseDeidentifyInput(payload)).toThrow(DeidentificationError);
    },
  );

  it.each([
    { confirmUsername: "target_user" },
    { reason: "permintaan melalui email" },
    { confirmUsername: "target_user", reason: 7 },
    { confirmUsername: null, reason: "permintaan melalui email" },
  ])("refuses %o, whose fields are not both strings", (payload) => {
    expect(() => parseDeidentifyInput(payload)).toThrow(DeidentificationError);
  });

  it("refuses with the payload code rather than a confirmation or reason code", () => {
    // A body of the wrong shape is neither a confirmation that failed nor a reason that is
    // missing, and answering one of those would tell the operator to fix the wrong thing.
    try {
      parseDeidentifyInput({ confirmUsername: "target_user" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(DeidentificationError);
      expect((error as DeidentificationError).code).toBe("deidentify_invalid_payload");
      expect((error as DeidentificationError).status).toBe(400);
    }
  });
});

describe("deidentificationObjectPrefixes", () => {
  it("lists the account's own prefixes when it has no registrations and no personal institution", () => {
    const prefixes = deidentificationObjectPrefixes({
      userId: USER,
      registrations: [],
      personalInstitutionId: null,
    });

    expect(prefixes).toEqual([
      `avatars/${USER}/`,
      `banners/${USER}/`,
      `resumes/${USER}/`,
      `profile-certifications/${USER}/`,
      `recruiter-verification/${USER}/`,
    ]);
  });

  it("lists a registration-document prefix per registration the account holds alone", () => {
    const prefixes = deidentificationObjectPrefixes({
      userId: USER,
      registrations: [
        { registrationId: "reg-1", competitionId: "comp-1", teamId: null },
        { registrationId: "reg-2", competitionId: "comp-2", teamId: null },
      ],
      personalInstitutionId: null,
    });

    expect(prefixes).toContain("registration-documents/comp-1/reg-1/");
    expect(prefixes).toContain("registration-documents/comp-2/reg-2/");
  });

  it("never lists a submissions prefix, on any target", () => {
    // That prefix is scoped by registration, and a registration with a team is shared — listing it
    // deletes a teammate's entry. Submission objects are reached by key instead.
    const prefixes = deidentificationObjectPrefixes({
      userId: USER,
      registrations: [
        { registrationId: "reg-1", competitionId: "comp-1", teamId: null },
        { registrationId: "reg-2", competitionId: "comp-2", teamId: null },
      ],
      personalInstitutionId: INSTITUTION,
    });

    expect(prefixes.some((prefix) => prefix.startsWith("submissions/"))).toBe(false);
  });

  it("leaves a team registration out entirely, so no scope of it is listed", () => {
    const prefixes = deidentificationObjectPrefixes({
      userId: USER,
      registrations: [
        { registrationId: "reg-solo", competitionId: "comp-1", teamId: null },
        { registrationId: "reg-team", competitionId: "comp-2", teamId: "team-1" },
      ],
      personalInstitutionId: null,
    });

    expect(prefixes).toContain("registration-documents/comp-1/reg-solo/");
    expect(prefixes.some((prefix) => prefix.includes("reg-team"))).toBe(false);
  });

  it("truncates the registration-document prefix after the registration, so it lists a superset", () => {
    // The service does not know the request ids, and an over-listed prefix finds nothing while an
    // under-listed one leaves a file behind — so the cut is deliberate and is asserted, not implied.
    const prefixes = deidentificationObjectPrefixes({
      userId: USER,
      registrations: [{ registrationId: "reg-1", competitionId: "comp-1", teamId: null }],
      personalInstitutionId: null,
    });

    expect(prefixes).toContain("registration-documents/comp-1/reg-1/");
    expect(prefixes.some((prefix) => prefix.includes("{requestId}"))).toBe(false);
  });

  it("adds the personal institution's four prefixes when the account owns one", () => {
    const prefixes = deidentificationObjectPrefixes({
      userId: USER,
      registrations: [],
      personalInstitutionId: INSTITUTION,
    });

    expect(prefixes).toContain(`institution-logos/${INSTITUTION}/`);
    expect(prefixes).toContain(`institution-banners/${INSTITUTION}/`);
    expect(prefixes).toContain(`payment-instructions/${INSTITUTION}/`);
    expect(prefixes).toContain(`verification/${INSTITUTION}/`);
  });

  it("never lists payment-proofs, on any target", () => {
    // Those objects sit behind rows DEC-0133 forbids deleting: removing the image would leave an
    // immutable ledger row pointing at nothing.
    const prefixes = deidentificationObjectPrefixes({
      userId: USER,
      registrations: [
        { registrationId: "reg-1", competitionId: "comp-1", teamId: null },
        { registrationId: "reg-2", competitionId: "comp-2", teamId: null },
      ],
      personalInstitutionId: INSTITUTION,
    });

    expect(prefixes.some((prefix) => prefix.startsWith("payment-proofs/"))).toBe(false);
  });

  it("leaves no placeholder unfilled, so no prefix is a template rather than a path", () => {
    const prefixes = deidentificationObjectPrefixes({
      userId: USER,
      registrations: [{ registrationId: "reg-1", competitionId: "comp-1", teamId: null }],
      personalInstitutionId: INSTITUTION,
    });

    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) {
      expect(prefix, `${prefix} still carries a placeholder`).not.toMatch(/[{}]/);
    }
  });
});

// THE ORDER OF TWO LOCK CALLS, WHICH NO RUN OF THIS SUITE CAN OBSERVE.
//
// The action takes the institution's owner-membership lock and the target's row, and the harm this
// asserts against is a MOVE rather than a removal: both calls present, both doing their job, and a
// writer that takes them in the other order can end up holding one while waiting for the other. That
// is a deadlock between two writers, so it needs two writers to happen at all — and a race test
// cannot be made to produce it on demand, because the failure needs an interleaving the test cannot
// schedule. What the move is, exactly, is a change of position in the source, so the position is
// what is asserted.
describe("the order the writing transaction takes its locks in", () => {
  it("takes the institution's owner-membership lock before the target's row", () => {
    const source = readServiceCode();

    const institutionLockAt = source.indexOf("await lockInstitutionOwnership(tx, lockedInstitutionIds);");
    const rowLockAt = source.indexOf('.for("update");');

    // Both ends asserted before the comparison: a rename that left either identifier absent would
    // otherwise be measured as -1, which is smaller than any index and passes as the right order.
    expect(institutionLockAt, "no owner-membership lock in the writing transaction").toBeGreaterThan(
      -1,
    );
    expect(rowLockAt, "no row lock in the writing transaction").toBeGreaterThan(-1);

    expect(
      institutionLockAt,
      "the writing transaction takes the target's row before the institution's owner-membership " +
        "lock: two writers can then hold one lock each and wait for the other",
    ).toBeLessThan(rowLockAt);
  });
});
