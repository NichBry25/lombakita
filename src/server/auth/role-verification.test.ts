// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  decidePostLoginDestination,
  isVerifiableRole,
  VERIFIABLE_ROLES,
} from "@/server/auth/role-verification";

describe("isVerifiableRole", () => {
  it("accepts 'candidate' and 'recruiter'", () => {
    expect(isVerifiableRole("candidate")).toBe(true);
    expect(isVerifiableRole("recruiter")).toBe(true);
  });

  it("rejects non-user-mode AppRoles", () => {
    expect(isVerifiableRole("platform_ops")).toBe(false);
    expect(isVerifiableRole("finance_ops")).toBe(false);
    expect(isVerifiableRole("reviewer_or_judge")).toBe(false);
  });

  it("rejects unknown / legacy / non-string values", () => {
    expect(isVerifiableRole("student")).toBe(false);
    expect(isVerifiableRole("institution_admin")).toBe(false);
    expect(isVerifiableRole(undefined)).toBe(false);
    expect(isVerifiableRole(null)).toBe(false);
    expect(isVerifiableRole(42)).toBe(false);
  });
});

describe("VERIFIABLE_ROLES is the user-level dual-mode set", () => {
  it("contains exactly candidate and recruiter", () => {
    expect([...VERIFIABLE_ROLES].sort()).toEqual(["candidate", "recruiter"]);
  });
});

describe("decidePostLoginDestination — pure decision over verification state", () => {
  it("routes a candidate-only account to the second-role prompt by default", () => {
    expect(
      decidePostLoginDestination(
        { candidateVerified: true, recruiterVerified: false },
        false,
      ),
    ).toBe("/auth/second-role-prompt");
  });

  it("routes a recruiter-only account to the second-role prompt by default", () => {
    expect(
      decidePostLoginDestination(
        { candidateVerified: false, recruiterVerified: true },
        false,
      ),
    ).toBe("/auth/second-role-prompt");
  });

  it("routes a candidate-only account to /candidate-dashboard when the prompt is dismissed", () => {
    expect(
      decidePostLoginDestination(
        { candidateVerified: true, recruiterVerified: false },
        true,
      ),
    ).toBe("/candidate-dashboard");
  });

  it("routes a recruiter-only account to /recruiter-dashboard when the prompt is dismissed", () => {
    expect(
      decidePostLoginDestination(
        { candidateVerified: false, recruiterVerified: true },
        true,
      ),
    ).toBe("/recruiter-dashboard");
  });

  it("routes a dual-role account directly to a dashboard regardless of dismissal flag", () => {
    expect(
      decidePostLoginDestination(
        { candidateVerified: true, recruiterVerified: true },
        false,
      ),
    ).toBe("/candidate-dashboard");
    expect(
      decidePostLoginDestination(
        { candidateVerified: true, recruiterVerified: true },
        true,
      ),
    ).toBe("/candidate-dashboard");
  });

  it("fails closed when neither role is verified (should not be reachable per DB CHECK)", () => {
    expect(
      decidePostLoginDestination(
        { candidateVerified: false, recruiterVerified: false },
        false,
      ),
    ).toBe("/auth/sign-in");
  });
});
