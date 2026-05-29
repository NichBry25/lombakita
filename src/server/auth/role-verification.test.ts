// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isVerifiableRole, VERIFIABLE_ROLES } from "@/server/auth/role-verification";

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

