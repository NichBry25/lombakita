// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  deriveCorporateEmailDomainFlag,
  isValidEmailAddress,
  isValidMobileNumber,
  parseRecruiterVerificationInput,
  RecruiterVerificationError,
} from "./recruiter-verification-core";

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

describe("parseRecruiterVerificationInput", () => {
  it("parses a complete form and lowercases the corporate email", () => {
    const parsed = parseRecruiterVerificationInput({
      fullName: "  Rendra Wijaya ",
      mobileNumber: " 0812-3456-789 ",
      corporateEmail: "Rendra@Corp.CO.ID",
    });

    expect(parsed).toEqual({
      fullName: "Rendra Wijaya",
      mobileNumber: "0812-3456-789",
      corporateEmail: "rendra@corp.co.id",
    });
  });

  it("treats an absent, null, or blank corporate email as null (optional field)", () => {
    for (const corporateEmail of [undefined, null, "", "   "]) {
      const parsed = parseRecruiterVerificationInput({
        fullName: "Rendra Wijaya",
        mobileNumber: "0812345678",
        corporateEmail,
      });
      expect(parsed.corporateEmail).toBeNull();
    }
  });

  it("rejects a short full name", () => {
    expect(() =>
      parseRecruiterVerificationInput({ fullName: "R", mobileNumber: "0812345678" }),
    ).toThrow(RecruiterVerificationError);
  });

  it("rejects a mobile number with fewer than 8 digits", () => {
    expect(() =>
      parseRecruiterVerificationInput({ fullName: "Rendra Wijaya", mobileNumber: "0812" }),
    ).toThrow(RecruiterVerificationError);
  });

  it("rejects a malformed corporate email", () => {
    expect(() =>
      parseRecruiterVerificationInput({
        fullName: "Rendra Wijaya",
        mobileNumber: "0812345678",
        corporateEmail: "not-an-email",
      }),
    ).toThrow(RecruiterVerificationError);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseRecruiterVerificationInput("nope")).toThrow(RecruiterVerificationError);
  });
});

describe("deriveCorporateEmailDomainFlag", () => {
  it("returns null when no corporate email is present", () => {
    expect(deriveCorporateEmailDomainFlag(null)).toBeNull();
  });

  it("returns false for a known personal-provider domain", () => {
    expect(deriveCorporateEmailDomainFlag("rendra@gmail.com")).toBe(false);
  });

  it("returns true for a non-personal (corporate) domain", () => {
    expect(deriveCorporateEmailDomainFlag("rendra@corp.co.id")).toBe(true);
  });
});
