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
  it("normalizes email and persists declared signup role", () => {
    const parsed = parseRegistrationInput({
      name: "  Dinda Putri ",
      email: "  Dinda@Campus.AC.ID ",
      password: "very-strong-password",
      signupRole: "candidate",
    });

    expect(parsed).toEqual({
      name: "Dinda Putri",
      email: "dinda@campus.ac.id",
      password: "very-strong-password",
      signupRole: "candidate",
    });
  });

  it("accepts the recruiter signup role declaration", () => {
    const parsed = parseRegistrationInput({
      name: "Rendra",
      email: "rendra@example.com",
      password: "very-strong-password",
      signupRole: "recruiter",
    });

    expect(parsed.signupRole).toBe("recruiter");
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
