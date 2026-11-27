// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  CredentialsAuthError,
  normalizeEmail,
  parseEmailPayload,
  parseRegistrationInput,
} from "@/server/auth/credentials-auth";

describe("credentials-auth validation", () => {
  it("normalizes email and returns the participant details", () => {
    const parsed = parseRegistrationInput({
      name: "  Dinda Putri ",
      email: "  Dinda@Campus.AC.ID ",
      password: "very-strong-password",
      fullName: "Dinda Putri",
      phoneNumber: "0812345678",
      occupation: "college_student",
      dateOfBirth: "2000-01-15",
    });

    expect(parsed).toEqual({
      name: "Dinda Putri",
      email: "dinda@campus.ac.id",
      password: "very-strong-password",
      candidateProfile: {
        fullName: "Dinda Putri",
        phoneNumber: "0812345678",
        occupation: "college_student",
        dateOfBirth: "2000-01-15",
      },
    });
  });

  it("rejects a sign-up missing the participant details", () => {
    expect(() =>
      parseRegistrationInput({
        name: "Dinda Putri",
        email: "dinda@campus.ac.id",
        password: "very-strong-password",
      }),
    ).toThrow(CredentialsAuthError);
  });

  it("ignores a host role and host fields sent with a sign-up", () => {
    const parsed = parseRegistrationInput({
      name: "Rendra",
      email: "rendra@example.com",
      password: "very-strong-password",
      signupRole: "recruiter",
      role: "recruiter",
      fullName: "Rendra Wijaya",
      phoneNumber: "0812345678",
      occupation: "college_student",
      dateOfBirth: "2000-01-15",
      mobileNumber: "0812345678",
      corporateEmail: "Rendra@Corp.CO.ID",
    });

    expect(parsed).toEqual({
      name: "Rendra",
      email: "rendra@example.com",
      password: "very-strong-password",
      candidateProfile: {
        fullName: "Rendra Wijaya",
        phoneNumber: "0812345678",
        occupation: "college_student",
        dateOfBirth: "2000-01-15",
      },
    });
  });

  it("refuses a host sign-up that carries no participant details", () => {
    let refusal: unknown;
    try {
      parseRegistrationInput({
        name: "Rendra",
        email: "rendra@example.com",
        password: "very-strong-password",
        signupRole: "recruiter",
        fullName: "Rendra Wijaya",
        mobileNumber: "0812345678",
        corporateEmail: "rendra@corp.co.id",
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(CredentialsAuthError);
    expect(refusal).toMatchObject({ code: "candidate_profile_invalid_value", status: 400 });
    expect((refusal as CredentialsAuthError).details).toEqual({ fields: ["phoneNumber"] });
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

  it("parses email-only payload", () => {
    const parsed = parseEmailPayload({
      email: "  user@example.com ",
    });

    expect(parsed.email).toBe("user@example.com");
  });

  it("normalizes email helper", () => {
    expect(normalizeEmail("  USER@Example.COM ")).toBe("user@example.com");
  });

  it("keeps the field name of a refused candidate profile", () => {
    let refusal: unknown;
    try {
      parseRegistrationInput({
        name: "  Dinda Putri ",
        email: "  Dinda@Campus.AC.ID ",
        password: "very-strong-password",
        signupRole: "candidate",
        fullName: "Dinda Putri",
        phoneNumber: "12",
        occupation: "college_student",
        dateOfBirth: "2000-01-15",
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(CredentialsAuthError);
    expect(refusal).toMatchObject({ code: "candidate_profile_invalid_value" });
    expect((refusal as CredentialsAuthError).details).toEqual({ fields: ["phoneNumber"] });
  });
});
