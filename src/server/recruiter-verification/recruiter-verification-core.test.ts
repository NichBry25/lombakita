// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isValidEmailAddress, isValidMobileNumber } from "./recruiter-verification-core";

describe("the shared contact checks", () => {
  it("isValidMobileNumber accepts the numbers the host sign-up accepts and refuses the rest", () => {
    expect(isValidMobileNumber("0812-3456-7890")).toBe(true);
    expect(isValidMobileNumber("+62 812 3456 7890")).toBe(true);
    expect(isValidMobileNumber("0812-ABC-7890")).toBe(false);
    expect(isValidMobileNumber("1234567")).toBe(false);
    expect(isValidMobileNumber("1".repeat(21))).toBe(false);
  });

  it("isValidEmailAddress accepts a lowercased address and refuses a malformed or overlong one", () => {
    const overlong = `${"a".repeat(255 - "@example.test".length)}@example.test`;
    expect(overlong).toHaveLength(255);
    expect(isValidEmailAddress("panitia@example.test")).toBe(true);
    expect(isValidEmailAddress("panitia@")).toBe(false);
    expect(isValidEmailAddress("pani tia@example.test")).toBe(false);
    expect(isValidEmailAddress(overlong)).toBe(false);
  });
});
