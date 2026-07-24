// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  deriveCorporateEmailDomainFlag,
  parseRecruiterVerificationInput,
  RecruiterVerificationError,
} from "./recruiter-verification-core";

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
