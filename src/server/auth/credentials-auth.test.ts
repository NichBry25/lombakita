// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  CredentialsAuthError,
  normalizeEmail,
  parseEmailPayload,
  parseRegistrationInput,
} from "@/server/auth/credentials-auth";

describe("credentials-auth validation", () => {
  it("normalizes email in registration payload", () => {
    const parsed = parseRegistrationInput({
      name: "  Dinda Putri ",
      email: "  Dinda@Campus.AC.ID ",
      password: "very-strong-password",
    });

    expect(parsed).toEqual({
      name: "Dinda Putri",
      email: "dinda@campus.ac.id",
      password: "very-strong-password",
    });
  });

  it("rejects malformed registration payload", () => {
    expect(() =>
      parseRegistrationInput({
        name: "A",
        email: "invalid",
        password: "1234",
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
});
