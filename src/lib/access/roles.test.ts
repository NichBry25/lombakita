import { describe, expect, it } from "vitest";
import { APP_ROLES, DEFAULT_APP_ROLE, isAppRole } from "@/lib/access/roles";

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
