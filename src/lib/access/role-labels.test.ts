import { describe, expect, it } from "vitest";
import {
  getAppRoleLabel,
  getInstitutionRoleLabel,
  getTeamRoleLabel,
} from "@/lib/access/role-labels";

describe("role display labels", () => {
  it("localizes known application and membership roles", () => {
    expect(getAppRoleLabel("platform_ops")).toBe("Platform ops");
    expect(getInstitutionRoleLabel("institution_staff")).toBe("Staf");
    expect(getTeamRoleLabel("captain")).toBe("Kapten");
  });

  it("never exposes an unknown raw role token", () => {
    expect(getAppRoleLabel("future_ops_role")).toBe("Future ops role");
  });
});
