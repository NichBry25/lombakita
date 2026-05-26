// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { mockGetDb, getRecruiterTierForAccount } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  getRecruiterTierForAccount: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/auth/recruiter-tier", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/auth/recruiter-tier")>(
      "@/server/auth/recruiter-tier",
    );
  return { ...actual, getRecruiterTierForAccount };
});

import {
  elevateRecruiterTier,
  ELEVATION_TARGET_TIER,
  parseElevationInput,
  RecruiterTierElevationError,
} from "./recruiter-tier-service";

const buildUpdateDb = () => {
  const updateChain = {
    set: vi.fn(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  updateChain.set.mockReturnValue(updateChain);
  return { db: { update: vi.fn().mockReturnValue(updateChain) }, updateChain };
};

describe("ELEVATION_TARGET_TIER", () => {
  it("is 'elevated'", () => {
    expect(ELEVATION_TARGET_TIER).toBe("elevated");
  });
});

describe("parseElevationInput", () => {
  it("accepts { tier: 'elevated' }", () => {
    expect(parseElevationInput({ tier: "elevated" })).toEqual({ tier: "elevated" });
  });

  it("rejects { tier: 'minimal' } with tier_invalid_target", () => {
    expect(() => parseElevationInput({ tier: "minimal" })).toThrowError(
      RecruiterTierElevationError,
    );
    try {
      parseElevationInput({ tier: "minimal" });
    } catch (error) {
      expect((error as RecruiterTierElevationError).code).toBe("tier_invalid_target");
      expect((error as RecruiterTierElevationError).status).toBe(400);
    }
  });

  it("rejects unknown tier values", () => {
    expect(() => parseElevationInput({ tier: "verified" })).toThrowError(
      RecruiterTierElevationError,
    );
  });

  it("rejects { tier: 'unverified' }", () => {
    expect(() => parseElevationInput({ tier: "unverified" })).toThrowError(
      RecruiterTierElevationError,
    );
  });

  it("rejects non-object payload", () => {
    expect(() => parseElevationInput(null)).toThrowError(RecruiterTierElevationError);
    expect(() => parseElevationInput([])).toThrowError(RecruiterTierElevationError);
    expect(() => parseElevationInput("elevated")).toThrowError(RecruiterTierElevationError);
  });
});

describe("elevateRecruiterTier", () => {
  it("throws tier_account_not_found (404) when target account is missing", async () => {
    getRecruiterTierForAccount.mockResolvedValue(null);
    const { db } = buildUpdateDb();

    await expect(elevateRecruiterTier("ops_1", "ghost", db as never)).rejects.toMatchObject({
      code: "tier_account_not_found",
      status: 404,
    });
  });

  it("throws tier_target_not_recruiter_verified (422) for candidate-only target", async () => {
    getRecruiterTierForAccount.mockResolvedValue({
      recruiterVerified: false,
      recruiterVerificationTier: "unverified",
    });
    const { db } = buildUpdateDb();

    await expect(elevateRecruiterTier("ops_1", "u1", db as never)).rejects.toMatchObject({
      code: "tier_target_not_recruiter_verified",
      status: 422,
    });
  });

  it("returns changed=true and writes UPDATE on minimal → elevated", async () => {
    getRecruiterTierForAccount.mockResolvedValue({
      recruiterVerified: true,
      recruiterVerificationTier: "minimal",
    });
    const { db, updateChain } = buildUpdateDb();

    const result = await elevateRecruiterTier("ops_1", "u1", db as never);

    expect(result).toEqual({ accountId: "u1", tier: "elevated", changed: true });
    expect(updateChain.set).toHaveBeenCalled();
  });

  it("returns changed=false and skips UPDATE when already elevated (idempotent)", async () => {
    getRecruiterTierForAccount.mockResolvedValue({
      recruiterVerified: true,
      recruiterVerificationTier: "elevated",
    });
    const { db, updateChain } = buildUpdateDb();

    const result = await elevateRecruiterTier("ops_1", "u1", db as never);

    expect(result).toEqual({ accountId: "u1", tier: "elevated", changed: false });
    expect(updateChain.set).not.toHaveBeenCalled();
  });

  // Step 4.0c (4.0c-T1) — Concurrent platform-ops elevation requests on the same account.
  // The CAS WHERE clause in elevateRecruiterTier prevents both UPDATEs from landing — only one
  // matches the snapshot tier. The second call's snapshot read sees `elevated` and returns the
  // idempotent { changed: false } path. End state is always `elevated`; the second call is
  // never an error.
  it("handles concurrent elevation requests idempotently — end state always 'elevated' (4.0c-T1)", async () => {
    // Simulate the second call's snapshot read landing AFTER the first has committed: it
    // observes `elevated` instead of `minimal`, so it takes the idempotent fast-path.
    getRecruiterTierForAccount
      .mockResolvedValueOnce({
        recruiterVerified: true,
        recruiterVerificationTier: "minimal",
      })
      .mockResolvedValueOnce({
        recruiterVerified: true,
        recruiterVerificationTier: "elevated",
      });
    const { db, updateChain } = buildUpdateDb();

    const first = await elevateRecruiterTier("ops_1", "u1", db as never);
    const second = await elevateRecruiterTier("ops_2", "u1", db as never);

    expect(first).toEqual({ accountId: "u1", tier: "elevated", changed: true });
    expect(second).toEqual({ accountId: "u1", tier: "elevated", changed: false });
    // Only one UPDATE statement reached the DB layer across the two requests.
    expect(updateChain.set).toHaveBeenCalledTimes(1);
  });
});
