// @vitest-environment node

import { describe, expect, it } from "vitest";
import { assertValidTransition, parseVerifyInput, VerificationError } from "./verification-core";
import type { InstitutionVerificationStatus } from "@/server/db/schema";

describe("assertValidTransition", () => {
  const validCases: [InstitutionVerificationStatus, InstitutionVerificationStatus][] = [
    ["pending_verification", "under_review"],
    ["pending_verification", "rejected"],
    ["under_review", "verified"],
    ["under_review", "rejected"],
  ];

  it.each(validCases)("allows %s → %s", (from, to) => {
    expect(() => assertValidTransition(from, to)).not.toThrow();
  });

  const invalidCases: [InstitutionVerificationStatus, InstitutionVerificationStatus][] = [
    ["pending_verification", "verified"],
    ["verified", "under_review"],
    ["verified", "rejected"],
    ["verified", "pending_verification"],
    ["rejected", "under_review"],
    ["rejected", "verified"],
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
