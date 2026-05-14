import { describe, expect, it } from "vitest";
import { APP_ROLES, DEFAULT_APP_ROLE, isAppRole } from "@/lib/access/roles";

describe("access roles", () => {
  it("contains required baseline roles", () => {
    expect(APP_ROLES).toContain("student");
    expect(APP_ROLES).toContain("institution_admin");
    expect(APP_ROLES).toContain("institution_staff");
    expect(APP_ROLES).toContain("platform_ops");
    expect(APP_ROLES).toContain("finance_ops");
    expect(DEFAULT_APP_ROLE).toBe("student");
  });

  it("validates role values", () => {
    expect(isAppRole("student")).toBe(true);
    expect(isAppRole("unknown_role")).toBe(false);
  });
});
