// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  CredentialsAuthError,
  isSignupRole,
  normalizeEmail,
  parseEmailPayload,
  parseRegistrationInput,
} from "@/server/auth/credentials-auth";

describe("credentials-auth validation", () => {
  it("normalizes email and persists declared signup role with candidate onboarding profile", () => {
    const parsed = parseRegistrationInput({
      name: "  Dinda Putri ",
      email: "  Dinda@Campus.AC.ID ",
      password: "very-strong-password",
      signupRole: "candidate",
      fullName: "Dinda Putri",
      phoneNumber: "0812345678",
      occupation: "college_student",
      dateOfBirth: "2000-01-15",
    });

    expect(parsed).toEqual({
      name: "Dinda Putri",
      email: "dinda@campus.ac.id",
      password: "very-strong-password",
      signupRole: "candidate",
      candidateProfile: {
        fullName: "Dinda Putri",
        phoneNumber: "0812345678",
        occupation: "college_student",
        dateOfBirth: "2000-01-15",
      },
      recruiterVerification: null,
    });
  });

  it("rejects a candidate signup missing its onboarding profile", () => {
    expect(() =>
      parseRegistrationInput({
        name: "Dinda Putri",
        email: "dinda@campus.ac.id",
        password: "very-strong-password",
        signupRole: "candidate",
      }),
    ).toThrow(CredentialsAuthError);
  });

  it("accepts the recruiter signup role declaration with the affiliation form", () => {
    const parsed = parseRegistrationInput({
      name: "Rendra",
      email: "rendra@example.com",
      password: "very-strong-password",
      signupRole: "recruiter",
      fullName: "Rendra Wijaya",
      mobileNumber: "0812345678",
      corporateEmail: "Rendra@Corp.CO.ID",
    });

    expect(parsed.signupRole).toBe("recruiter");
    expect(parsed.candidateProfile).toBeNull();
    expect(parsed.recruiterVerification).toEqual({
      fullName: "Rendra Wijaya",
      mobileNumber: "0812345678",
      corporateEmail: "rendra@corp.co.id",
    });
  });

  it("rejects a recruiter signup missing its affiliation form", () => {
    expect(() =>
      parseRegistrationInput({
        name: "Rendra",
        email: "rendra@example.com",
        password: "very-strong-password",
        signupRole: "recruiter",
      }),
    ).toThrow(CredentialsAuthError);
  });

  it("rejects malformed registration payload", () => {
    expect(() =>
      parseRegistrationInput({
        name: "A",
        email: "invalid",
        password: "1234",
        signupRole: "candidate",
      }),
    ).toThrow(CredentialsAuthError);
  });

  it("rejects registration payload missing the signup role declaration", () => {
    expect(() =>
      parseRegistrationInput({
        name: "Dinda Putri",
        email: "dinda@campus.ac.id",
        password: "very-strong-password",
      }),
    ).toThrowError(/Signup role declaration is required/i);
  });

  it("rejects unknown signup role declarations", () => {
    expect(() =>
      parseRegistrationInput({
        name: "Dinda Putri",
        email: "dinda@campus.ac.id",
        password: "very-strong-password",
        signupRole: "student",
      }),
    ).toThrowError(/Signup role declaration is required/i);
  });

  it("isSignupRole rejects legacy and unknown tokens", () => {
    expect(isSignupRole("candidate")).toBe(true);
    expect(isSignupRole("recruiter")).toBe(true);
    expect(isSignupRole("student")).toBe(false);
    expect(isSignupRole("institution_admin")).toBe(false);
    expect(isSignupRole(undefined)).toBe(false);
    expect(isSignupRole(null)).toBe(false);
  });

  it("parses email-only payload", () => {
    const parsed = parseEmailPayload({
      email: "  user@example.com ",
    });

    expect(parsed.email).toBe("user@example.com");
  });

  it("normalizes email helper", () => {
    expect(normalizeEmail("  USER@Example.COM ")).toBe("user@example.com");
  });
});
