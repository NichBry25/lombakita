// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  assertRecruiterTier,
  FULL_INSTITUTION_CREATION_MIN_TIER,
  getRecruiterTierForAccount,
  isRecruiterTier,
  meetsRecruiterTier,
  OPPORTUNITY_CREATION_MIN_TIER,
  PERSONAL_INSTITUTION_CREATION_MIN_TIER,
  RecruiterTierError,
  RECRUITER_TIERS,
} from "./recruiter-tier";
import type { AuthenticatedSession } from "./access-core";

const buildSelectDb = (row: unknown | null) => {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(row === null ? [] : [row]),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return { select: vi.fn().mockReturnValue(chain) };
};

const makeSession = (userId: string): AuthenticatedSession =>
  ({
    user: { id: userId, role: "recruiter", verifiedRoles: ["recruiter"] },
    expires: new Date(Date.now() + 60_000).toISOString(),
  }) as unknown as AuthenticatedSession;

describe("RECRUITER_TIERS", () => {
  it("contains exactly three values in the documented order", () => {
    expect(RECRUITER_TIERS).toEqual(["unverified", "minimal", "elevated"]);
  });
});

describe("OPPORTUNITY_CREATION_MIN_TIER", () => {
  it("is 'minimal' at launch (Step 4.0c)", () => {
    expect(OPPORTUNITY_CREATION_MIN_TIER).toBe("minimal");
  });
});

describe("institution-creation tier gates (Step 6.5f.1)", () => {
  it("personal institution creation requires the minimal tier", () => {
    expect(PERSONAL_INSTITUTION_CREATION_MIN_TIER).toBe("minimal");
  });

  it("full institution creation requires the elevated tier", () => {
    expect(FULL_INSTITUTION_CREATION_MIN_TIER).toBe("elevated");
  });

  it("the gates are independent of OPPORTUNITY_CREATION_MIN_TIER (unchanged)", () => {
    expect(OPPORTUNITY_CREATION_MIN_TIER).toBe("minimal");
    expect(FULL_INSTITUTION_CREATION_MIN_TIER).not.toBe(OPPORTUNITY_CREATION_MIN_TIER);
  });
});

describe("isRecruiterTier", () => {
  it("accepts the three enum values", () => {
    expect(isRecruiterTier("unverified")).toBe(true);
    expect(isRecruiterTier("minimal")).toBe(true);
    expect(isRecruiterTier("elevated")).toBe(true);
  });

  it("rejects unknown / legacy / non-string values", () => {
    expect(isRecruiterTier("verified")).toBe(false);
    expect(isRecruiterTier("MINIMAL")).toBe(false);
    expect(isRecruiterTier(undefined)).toBe(false);
    expect(isRecruiterTier(null)).toBe(false);
    expect(isRecruiterTier(1)).toBe(false);
  });
});

describe("meetsRecruiterTier", () => {
  it("respects monotonic ordering unverified < minimal < elevated", () => {
    expect(meetsRecruiterTier("unverified", "unverified")).toBe(true);
    expect(meetsRecruiterTier("unverified", "minimal")).toBe(false);
    expect(meetsRecruiterTier("unverified", "elevated")).toBe(false);

    expect(meetsRecruiterTier("minimal", "unverified")).toBe(true);
    expect(meetsRecruiterTier("minimal", "minimal")).toBe(true);
    expect(meetsRecruiterTier("minimal", "elevated")).toBe(false);

    expect(meetsRecruiterTier("elevated", "unverified")).toBe(true);
    expect(meetsRecruiterTier("elevated", "minimal")).toBe(true);
    expect(meetsRecruiterTier("elevated", "elevated")).toBe(true);
  });
});

describe("assertRecruiterTier", () => {
  it("throws recruiter_role_not_verified when recruiterVerifiedAt is null", async () => {
    const db = buildSelectDb({
      recruiterVerifiedAt: null,
      recruiterVerificationTier: "unverified",
    });
    const session = makeSession("u1");
    await expect(assertRecruiterTier(session, "minimal", db as never)).rejects.toMatchObject({
      code: "recruiter_role_not_verified",
      status: 403,
    });
  });

  it("throws recruiter_tier_insufficient when tier is below threshold", async () => {
    const db = buildSelectDb({
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "unverified",
    });
    const session = makeSession("u1");
    await expect(assertRecruiterTier(session, "minimal", db as never)).rejects.toMatchObject({
      code: "recruiter_tier_insufficient",
      status: 403,
      details: { requiredTier: "minimal", currentTier: "unverified" },
    });
  });

  it("resolves when tier exactly meets the threshold", async () => {
    const db = buildSelectDb({
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "minimal",
    });
    const session = makeSession("u1");
    await expect(assertRecruiterTier(session, "minimal", db as never)).resolves.toBeUndefined();
  });

  it("resolves when tier exceeds the threshold (elevated satisfies minimal)", async () => {
    const db = buildSelectDb({
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    });
    const session = makeSession("u1");
    await expect(assertRecruiterTier(session, "minimal", db as never)).resolves.toBeUndefined();
  });

  it("throws recruiter_tier_insufficient when minimal asked for elevated threshold", async () => {
    const db = buildSelectDb({
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "minimal",
    });
    const session = makeSession("u1");
    await expect(assertRecruiterTier(session, "elevated", db as never)).rejects.toMatchObject({
      code: "recruiter_tier_insufficient",
      details: { requiredTier: "elevated", currentTier: "minimal" },
    });
  });

  it("throws recruiter_role_not_verified when user row does not exist", async () => {
    const db = buildSelectDb(null);
    const session = makeSession("ghost");
    await expect(assertRecruiterTier(session, "minimal", db as never)).rejects.toBeInstanceOf(
      RecruiterTierError,
    );
  });
});

describe("getRecruiterTierForAccount", () => {
  it("returns null when account does not exist", async () => {
    const db = buildSelectDb(null);
    await expect(getRecruiterTierForAccount("ghost", db as never)).resolves.toBeNull();
  });

  it("returns the tier state shape", async () => {
    const verifiedAt = new Date();
    const db = buildSelectDb({
      recruiterVerifiedAt: verifiedAt,
      recruiterVerificationTier: "elevated",
    });
    await expect(getRecruiterTierForAccount("u1", db as never)).resolves.toEqual({
      recruiterVerified: true,
      recruiterVerificationTier: "elevated",
    });
  });
});
