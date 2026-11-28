// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  assertValidTransition,
  normalizeInstagramProfileUrl,
  parseVerificationSubmitBody,
  parseVerifyInput,
  VerificationError,
} from "./verification-core";
import type { InstitutionVerificationStatus } from "@/server/db/schema";

describe("assertValidTransition", () => {
  const validCases: [InstitutionVerificationStatus, InstitutionVerificationStatus][] = [
    ["pending_verification", "under_review"],
    ["pending_verification", "rejected"],
    // What approving a document submission actually does. Previously refused here while the
    // submission path wrote it anyway, so the rulebook described a rule the product did not follow.
    ["pending_verification", "verified"],
    ["under_review", "verified"],
    ["under_review", "rejected"],
    // Revocation. Reason is mandatory — parseVerifyInput enforces that for every 'rejected' target.
    ["verified", "rejected"],
    // The way back for a denied or revoked institution: re-open for review, or approve the fresh
    // submission it filed.
    ["rejected", "under_review"],
    ["rejected", "verified"],
  ];

  it.each(validCases)("allows %s → %s", (from, to) => {
    expect(() => assertValidTransition(from, to)).not.toThrow();
  });

  const invalidCases: [InstitutionVerificationStatus, InstitutionVerificationStatus][] = [
    // Un-verifying is only ever an explicit, reasoned revocation — never a quiet drop back into
    // the review queue.
    ["verified", "under_review"],
    // pending_verification is the state an institution is created in. The one move back to it,
    // verified->pending_verification, is written only by removeTickAutomatically and no request
    // may ask for it.
    ["verified", "pending_verification"],
    ["rejected", "pending_verification"],
    ["under_review", "pending_verification"],
  ];

  it.each(invalidCases)("throws 409 for %s → %s", (from, to) => {
    expect(() => assertValidTransition(from, to)).toThrow(VerificationError);
    try {
      assertValidTransition(from, to);
    } catch (err) {
      expect(err).toBeInstanceOf(VerificationError);
      if (err instanceof VerificationError) {
        expect(err.code).toBe("verification_invalid_transition");
        expect(err.status).toBe(409);
      }
    }
  });
});

describe("parseVerifyInput", () => {
  it("parses valid under_review transition", () => {
    const result = parseVerifyInput({ targetStatus: "under_review" });
    expect(result.targetStatus).toBe("under_review");
    expect(result.reason).toBeUndefined();
  });

  it("parses valid verified transition", () => {
    const result = parseVerifyInput({ targetStatus: "verified" });
    expect(result.targetStatus).toBe("verified");
  });

  it("parses rejected with reason", () => {
    const result = parseVerifyInput({ targetStatus: "rejected", reason: "Dokumen tidak lengkap" });
    expect(result.targetStatus).toBe("rejected");
    expect(result.reason).toBe("Dokumen tidak lengkap");
  });

  it("throws 422 when rejecting without reason", () => {
    expect(() => parseVerifyInput({ targetStatus: "rejected" })).toThrow(VerificationError);
    try {
      parseVerifyInput({ targetStatus: "rejected" });
    } catch (err) {
      if (err instanceof VerificationError) {
        expect(err.code).toBe("verification_reason_required");
        expect(err.status).toBe(422);
      }
    }
  });

  it("throws 422 when reason is empty string", () => {
    expect(() => parseVerifyInput({ targetStatus: "rejected", reason: "   " })).toThrow(
      VerificationError,
    );
    try {
      parseVerifyInput({ targetStatus: "rejected", reason: "   " });
    } catch (err) {
      if (err instanceof VerificationError) {
        expect(err.code).toBe("verification_reason_required");
        expect(err.status).toBe(422);
      }
    }
  });

  it("throws 400 for invalid targetStatus", () => {
    expect(() => parseVerifyInput({ targetStatus: "active" })).toThrow(VerificationError);
    try {
      parseVerifyInput({ targetStatus: "active" });
    } catch (err) {
      if (err instanceof VerificationError) {
        expect(err.code).toBe("verification_invalid_payload");
        expect(err.status).toBe(400);
      }
    }
  });

  it("throws 400 for non-object body", () => {
    expect(() => parseVerifyInput("invalid")).toThrow(VerificationError);
    expect(() => parseVerifyInput(null)).toThrow(VerificationError);
    expect(() => parseVerifyInput([])).toThrow(VerificationError);
  });

  it("trims whitespace from reason", () => {
    const result = parseVerifyInput({ targetStatus: "rejected", reason: "  alasan   " });
    expect(result.reason).toBe("alasan");
  });
});

describe("normalizeInstagramProfileUrl", () => {
  it.each([
    ["https://instagram.com/Acme.Org", "https://www.instagram.com/acme.org/"],
    ["https://www.instagram.com/acme_org/", "https://www.instagram.com/acme_org/"],
    ["  https://instagram.com/acme?utm=1#bio  ", "https://www.instagram.com/acme/"],
  ])("stores %s as %s", (input, stored) => {
    expect(normalizeInstagramProfileUrl(input)).toBe(stored);
  });

  it.each([
    "https://example.com/acme",
    "https://instagram.com/",
    "https://www.instagram.com/a-b",
    "http://instagram.com/acme",
    "https://instagram.com/acme/reels",
    `https://instagram.com/${"a".repeat(31)}`,
    "https://user@instagram.com/acme",
    "not a url",
    42,
    undefined,
  ])("refuses %j", (input) => {
    expect(() => normalizeInstagramProfileUrl(input)).toThrow(
      expect.objectContaining({ code: "institution_tick_instagram_invalid", status: 400 }),
    );
  });
});

describe("parseVerificationSubmitBody", () => {
  it("reads an absent path as documents and passes the documents on", () => {
    expect(parseVerificationSubmitBody({ documents: [1] })).toEqual({
      path: "documents",
      documents: [1],
    });
    expect(parseVerificationSubmitBody({ path: "documents", documents: [] })).toEqual({
      path: "documents",
      documents: [],
    });
  });

  it("normalizes the link of an instagram body", () => {
    expect(
      parseVerificationSubmitBody({
        path: "instagram",
        instagramUrl: "https://instagram.com/Acme",
      }),
    ).toEqual({ path: "instagram", instagramUrl: "https://www.instagram.com/acme/" });
  });

  it.each([
    [{ path: "other" }],
    [{ path: "domain", instagramUrl: "https://instagram.com/acme" }],
    [{ path: "staff", instagramUrl: "https://instagram.com/acme" }],
    [{ path: null }],
    [{ documents: [], instagramUrl: "https://instagram.com/acme" }],
    [{ path: "documents", documents: [], instagramUrl: "https://instagram.com/acme" }],
    ["text"],
    [null],
    [[]],
  ])("refuses %j with verification_invalid_payload", (body) => {
    expect(() => parseVerificationSubmitBody(body)).toThrow(
      expect.objectContaining({ code: "verification_invalid_payload", status: 400 }),
    );
  });
});
