// @vitest-environment node

import { describe, expect, it } from "vitest";
import { candidateRoleOfferPath } from "./candidate-role-offer-path";

const COMPETITION_PATH = "/competitions/acme/lomba-1";

describe("candidateRoleOfferPath", () => {
  it("offers a host the role page that returns to the competition", () => {
    expect(candidateRoleOfferPath("recruiter", ["recruiter"], COMPETITION_PATH)).toBe(
      "/auth/verify-role?as=candidate&callbackUrl=%2Fcompetitions%2Facme%2Flomba-1",
    );
  });

  it("offers nothing to an account that already holds the participant role", () => {
    expect(candidateRoleOfferPath("candidate", ["candidate"], COMPETITION_PATH)).toBeNull();
    expect(
      candidateRoleOfferPath("recruiter", ["recruiter", "candidate"], COMPETITION_PATH),
    ).toBeNull();
  });

  it("never offers the participant role to an operational account", () => {
    for (const role of ["platform_ops", "finance_ops", "reviewer_or_judge"]) {
      expect(candidateRoleOfferPath(role, ["candidate"], COMPETITION_PATH)).toBeNull();
      expect(candidateRoleOfferPath(role, [], COMPETITION_PATH)).toBeNull();
    }
  });

  it("offers nothing to a visitor who is not signed in", () => {
    expect(candidateRoleOfferPath(undefined, undefined, COMPETITION_PATH)).toBeNull();
  });
});
