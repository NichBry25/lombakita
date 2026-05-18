// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isLastAdmin } from "@/server/institution-members/member-core";

const admin = (membershipId: string) => ({ membershipId, role: "institution_owner" as const });
const staff = (membershipId: string) => ({ membershipId, role: "institution_staff" as const });

describe("isLastAdmin", () => {
  it("returns true when target is the only admin", () => {
    expect(isLastAdmin([admin("m1")], "m1")).toBe(true);
  });

  it("returns false when there are two admins and target is one of them", () => {
    expect(isLastAdmin([admin("m1"), admin("m2")], "m1")).toBe(false);
  });

  it("returns false when target is institution_staff (not an admin)", () => {
    expect(isLastAdmin([admin("m1"), staff("m2")], "m2")).toBe(false);
  });

  it("returns false when target membership id is not in the list", () => {
    expect(isLastAdmin([admin("m1")], "m99")).toBe(false);
  });

  it("returns false when there are no admins in the list", () => {
    expect(isLastAdmin([staff("m1"), staff("m2")], "m1")).toBe(false);
  });

  it("returns false when the membership list is empty", () => {
    expect(isLastAdmin([], "m1")).toBe(false);
  });

  it("returns true when there is exactly one admin among mixed members", () => {
    expect(isLastAdmin([admin("m1"), staff("m2"), staff("m3")], "m1")).toBe(true);
  });

  it("returns false for a staff member when there is exactly one admin who is different", () => {
    expect(isLastAdmin([admin("m1"), staff("m2")], "m2")).toBe(false);
  });
});
