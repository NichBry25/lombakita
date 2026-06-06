import { describe, expect, it } from "vitest";
import { APP_ROLES, DEFAULT_APP_ROLE, isAppRole, sessionHasRole } from "@/lib/access/roles";

describe("access roles", () => {
  it("contains the new user-level role set after CCR-01 rebuild", () => {
    expect(APP_ROLES).toEqual([
      "candidate",
      "recruiter",
      "reviewer_or_judge",
      "platform_ops",
      "finance_ops",
    ]);
    expect(DEFAULT_APP_ROLE).toBe("candidate");
  });

  it("rejects legacy and unknown role tokens", () => {
    expect(isAppRole("candidate")).toBe(true);
    expect(isAppRole("recruiter")).toBe(true);
    expect(isAppRole("student")).toBe(false);
    expect(isAppRole("institution_admin")).toBe(false);
    expect(isAppRole("institution_staff")).toBe(false);
    expect(isAppRole("unknown_role")).toBe(false);
  });
});

describe("sessionHasRole — DEC-0060 capability check", () => {
  it("matches the single active role", () => {
    expect(sessionHasRole("candidate", ["candidate"], "candidate")).toBe(true);
    expect(sessionHasRole("platform_ops", [], "platform_ops")).toBe(true);
  });

  it("grants a self-service account access to its other verified role", () => {
    // signed in as recruiter, but candidate is also verified
    expect(sessionHasRole("recruiter", ["candidate", "recruiter"], "candidate")).toBe(true);
    expect(sessionHasRole("candidate", ["candidate", "recruiter"], "recruiter")).toBe(true);
  });

  it("denies a self-service account a role it has not verified", () => {
    expect(sessionHasRole("candidate", ["candidate"], "recruiter")).toBe(false);
  });

  it("never folds verifiedRoles in for an operational active role (no privilege widening)", () => {
    // backfilled candidate_verified_at on an ops account must not grant candidate access
    expect(sessionHasRole("platform_ops", ["candidate"], "candidate")).toBe(false);
    expect(sessionHasRole("finance_ops", ["candidate"], "candidate")).toBe(false);
  });

  it("is defensive against missing/invalid inputs", () => {
    expect(sessionHasRole(undefined, undefined, "candidate")).toBe(false);
    expect(sessionHasRole("student", ["candidate"], "candidate")).toBe(false);
    expect(sessionHasRole("candidate", ["bogus"], "candidate")).toBe(true);
  });
});
