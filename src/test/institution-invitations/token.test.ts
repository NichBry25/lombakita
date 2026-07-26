// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildInvitationExpiresAt,
  generateRawToken,
  hashToken,
  InstitutionInvitationError,
  INVITATION_EXPIRY_DAYS,
  maskToken,
  parseInvitationCreateInput,
} from "@/server/institution-invitations/invitation-core";

describe("generateRawToken", () => {
  it("produces a 64-character hex string", () => {
    const token = generateRawToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  it("produces unique values on each call", () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a).not.toBe(b);
  });
});

describe("hashToken", () => {
  it("produces a 64-character hex string (SHA-256 digest)", () => {
    const hash = hashToken("some-raw-token");
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const token = generateRawToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("differs from the raw token", () => {
    const token = generateRawToken();
    expect(hashToken(token)).not.toBe(token);
  });

  it("produces different hashes for different inputs", () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(hashToken(a)).not.toBe(hashToken(b));
  });
});

describe("maskToken", () => {
  it("returns first 8 chars followed by an ellipsis", () => {
    const token = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    expect(maskToken(token)).toBe("abcdef12…");
  });
});

describe("parseInvitationCreateInput — role validation", () => {
  const validEmail = "staff@example.com";

  it.each(["institution_owner", "institution_staff", "institution_member"])(
    "accepts role %s",
    (role) => {
      const result = parseInvitationCreateInput({
        invitedIdentifier: validEmail,
        invitedRole: role,
      });
      expect(result.invitedRole).toBe(role);
    },
  );

  it("rejects legacy institution_admin value with invitation_invalid_role", () => {
    expect(() =>
      parseInvitationCreateInput({
        invitedIdentifier: validEmail,
        invitedRole: "institution_admin",
      }),
    ).toThrow(InstitutionInvitationError);

    try {
      parseInvitationCreateInput({
        invitedIdentifier: validEmail,
        invitedRole: "institution_admin",
      });
    } catch (err) {
      expect((err as InstitutionInvitationError).code).toBe("invitation_invalid_role");
      expect((err as InstitutionInvitationError).httpStatus).toBe(400);
    }
  });

  it("rejects an unknown role value", () => {
    expect(() =>
      parseInvitationCreateInput({ invitedIdentifier: validEmail, invitedRole: "super_admin" }),
    ).toThrow(InstitutionInvitationError);
  });

  it("rejects a missing role field", () => {
    expect(() => parseInvitationCreateInput({ invitedIdentifier: validEmail })).toThrow(
      InstitutionInvitationError,
    );
  });
});

describe("buildInvitationExpiresAt", () => {
  it("returns a date INVITATION_EXPIRY_DAYS days in the future", () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const expiry = buildInvitationExpiresAt(now);
    const expectedMs = now.getTime() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    expect(expiry.getTime()).toBe(expectedMs);
  });
});
