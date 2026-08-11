// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveMfaStatus } from "./mfa-status";

const INVALIDATED_AT = new Date("2026-08-01T00:00:00.000Z");
const INVALIDATED_AT_SECONDS = Math.floor(INVALIDATED_AT.getTime() / 1000);

describe("resolveMfaStatus", () => {
  it.each(["candidate", "recruiter"])("is not_applicable for self-service role %s", (role) => {
    expect(
      resolveMfaStatus({
        role,
        hasVerifiedFactor: false,
        mfaInvalidatedAt: null,
        tokenMfaVerifiedAtSeconds: undefined,
      }),
    ).toBe("not_applicable");
  });

  it("is not_applicable for an undefined role", () => {
    expect(
      resolveMfaStatus({
        role: undefined,
        hasVerifiedFactor: false,
        mfaInvalidatedAt: null,
        tokenMfaVerifiedAtSeconds: undefined,
      }),
    ).toBe("not_applicable");
  });

  it("is not_applicable for an unrecognised role token", () => {
    expect(
      resolveMfaStatus({
        role: "student",
        hasVerifiedFactor: false,
        mfaInvalidatedAt: null,
        tokenMfaVerifiedAtSeconds: undefined,
      }),
    ).toBe("not_applicable");
  });

  it.each(["platform_ops", "finance_ops", "reviewer_or_judge"])(
    "is enrolment_required for operational role %s with no verified factor",
    (role) => {
      expect(
        resolveMfaStatus({
          role,
          hasVerifiedFactor: false,
          mfaInvalidatedAt: null,
          tokenMfaVerifiedAtSeconds: undefined,
        }),
      ).toBe("enrolment_required");
    },
  );

  it("is challenge_required when a factor exists but the token carries no claim", () => {
    expect(
      resolveMfaStatus({
        role: "platform_ops",
        hasVerifiedFactor: true,
        mfaInvalidatedAt: null,
        tokenMfaVerifiedAtSeconds: undefined,
      }),
    ).toBe("challenge_required");
  });

  it("is satisfied when the claim is at exactly the invalidation instant", () => {
    expect(
      resolveMfaStatus({
        role: "platform_ops",
        hasVerifiedFactor: true,
        mfaInvalidatedAt: INVALIDATED_AT,
        tokenMfaVerifiedAtSeconds: INVALIDATED_AT_SECONDS,
      }),
    ).toBe("satisfied");
  });

  it("is satisfied when the claim is after invalidation", () => {
    expect(
      resolveMfaStatus({
        role: "finance_ops",
        hasVerifiedFactor: true,
        mfaInvalidatedAt: INVALIDATED_AT,
        tokenMfaVerifiedAtSeconds: INVALIDATED_AT_SECONDS + 3600,
      }),
    ).toBe("satisfied");
  });

  // GUARD-REMOVAL PROOF target: the `claimedAtMs >= invalidatedAtMs` comparison. This is what makes
  // a recovery-code reset (or a break-glass reset) actually take effect on an outstanding session.
  it("is challenge_required when the claim predates invalidation by one second", () => {
    expect(
      resolveMfaStatus({
        role: "platform_ops",
        hasVerifiedFactor: true,
        mfaInvalidatedAt: INVALIDATED_AT,
        tokenMfaVerifiedAtSeconds: INVALIDATED_AT_SECONDS - 1,
      }),
    ).toBe("challenge_required");
  });

  it("treats a null mfaInvalidatedAt as epoch zero — any real claim satisfies it", () => {
    expect(
      resolveMfaStatus({
        role: "platform_ops",
        hasVerifiedFactor: true,
        mfaInvalidatedAt: null,
        tokenMfaVerifiedAtSeconds: 1,
      }),
    ).toBe("satisfied");
  });
});
