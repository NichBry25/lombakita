// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockTrustHost } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockTrustHost: vi.fn(),
}));
vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/host-trust/host-trust-service", () => ({
  trustHostInTransaction: mockTrustHost,
}));

import {
  getUnverifiedRoles,
  isSecondRoleVerificationPromptDue,
  markRoleAsVerified,
  RoleVerificationError,
} from "./role-verification";

const buildSelectDb = (row: unknown | null) => {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(row === null ? [] : [row]),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);

  return {
    select: vi.fn().mockReturnValue(chain),
  };
};

describe("getUnverifiedRoles", () => {
  it("returns [] when both roles are verified", async () => {
    const db = buildSelectDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
    });
    await expect(getUnverifiedRoles("u1", db as never)).resolves.toEqual([]);
  });

  it("returns ['recruiter'] for a candidate-only account", async () => {
    const db = buildSelectDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });
    await expect(getUnverifiedRoles("u1", db as never)).resolves.toEqual(["recruiter"]);
  });

  it("returns ['candidate'] for a recruiter-only account", async () => {
    const db = buildSelectDb({
      candidateVerifiedAt: null,
      recruiterVerifiedAt: new Date(),
    });
    await expect(getUnverifiedRoles("u1", db as never)).resolves.toEqual(["candidate"]);
  });

  it("returns both when neither role is verified (DB CHECK violation — fail-safe path)", async () => {
    const db = buildSelectDb({ candidateVerifiedAt: null, recruiterVerifiedAt: null });
    await expect(getUnverifiedRoles("u1", db as never)).resolves.toEqual([
      "candidate",
      "recruiter",
    ]);
  });

  it("returns [] when the user row does not exist (deleted account)", async () => {
    const db = buildSelectDb(null);
    await expect(getUnverifiedRoles("u1", db as never)).resolves.toEqual([]);
  });
});

describe("isSecondRoleVerificationPromptDue", () => {
  it("returns false when the dismissal flag is set, regardless of state", async () => {
    const db = buildSelectDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });
    await expect(isSecondRoleVerificationPromptDue("u1", true, db as never)).resolves.toBe(false);
  });

  it("returns true when exactly one role is unverified and not dismissed", async () => {
    const db = buildSelectDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });
    await expect(isSecondRoleVerificationPromptDue("u1", false, db as never)).resolves.toBe(true);
  });

  it("returns false when both roles are verified", async () => {
    const db = buildSelectDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
    });
    await expect(isSecondRoleVerificationPromptDue("u1", false, db as never)).resolves.toBe(false);
  });
});

describe("markRoleAsVerified", () => {
  // Candidate onboarding profile written in the same transaction as the candidate verification
  // grant (parity with the credentials- and OAuth-signup candidacy paths).
  const candidateProfileFixture = {
    fullName: "Dinda Putri",
    phoneNumber: "0812345678",
    occupation: "college_student",
    dateOfBirth: "2000-01-15",
  } as const;

  beforeEach(() => {
    mockTrustHost.mockReset();
    mockTrustHost.mockResolvedValue(null);
  });

  // Helper that produces a tx with a select returning `row`, an update().set().where().returning()
  // chain that returns `grantedTier`, and an insert().values() chain that captures the candidate
  // profile write.
  const buildTxDb = (
    row: unknown | null,
    grantedTier: "unverified" | "minimal" | "elevated" = "minimal",
  ) => {
    const selectChain = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue(row === null ? [] : [row]),
    };
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);

    const updateChain = {
      set: vi.fn(),
      where: vi.fn(),
      returning: vi.fn().mockResolvedValue([{ tier: grantedTier }]),
    };
    updateChain.set.mockReturnValue(updateChain);
    updateChain.where.mockReturnValue(updateChain);

    const captures: { candidateProfileInsert: Record<string, unknown> | null } = {
      candidateProfileInsert: null,
    };
    const insertChain = {
      values: vi.fn((v: Record<string, unknown>) => {
        captures.candidateProfileInsert = v;
        return insertChain;
      }),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    };

    const tx = {
      select: vi.fn().mockReturnValue(selectChain),
      update: vi.fn().mockReturnValue(updateChain),
      insert: vi.fn().mockReturnValue(insertChain),
    };

    const db = {
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    };

    return { db, tx, updateChain, captures };
  };

  it("flips candidateVerifiedAt and writes the onboarding profile for an unverified candidate", async () => {
    const { db, updateChain, captures } = buildTxDb({
      candidateVerifiedAt: null,
      recruiterVerifiedAt: new Date(),
    });

    const result = await markRoleAsVerified(
      "u1",
      "candidate",
      candidateProfileFixture,
      db as never,
    );

    expect(updateChain.set).toHaveBeenCalled();
    expect(result.candidateVerified).toBe(true);
    expect(result.recruiterVerified).toBe(true);
    // Onboarding profile is written in the same transaction (parity with signup paths).
    expect(captures.candidateProfileInsert).toMatchObject({
      userId: "u1",
      fullName: "Dinda Putri",
      occupation: "college_student",
      dateOfBirth: "2000-01-15",
    });
  });

  it("throws candidate_profile_required when verifying candidate with no onboarding profile", async () => {
    const { db, tx } = buildTxDb({
      candidateVerifiedAt: null,
      recruiterVerifiedAt: new Date(),
    });

    await expect(markRoleAsVerified("u1", "candidate", null, db as never)).rejects.toMatchObject({
      code: "candidate_profile_required",
      status: 400,
    });
    // Fail closed before opening the transaction.
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("verifies the recruiter role with no form and writes no host request", async () => {
    const { db, tx } = buildTxDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });

    expect(await markRoleAsVerified("u1", "recruiter", null, db as never)).toEqual({
      candidateVerified: true,
      recruiterVerified: true,
      hostTrusted: false,
    });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("runs automatic trust after the recruiter grant and reports the account trusted", async () => {
    mockTrustHost.mockResolvedValue("sign_in_email");
    const { db, tx } = buildTxDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });

    const result = await markRoleAsVerified("u1", "recruiter", null, db as never);

    expect(result.hostTrusted).toBe(true);
    expect(mockTrustHost).toHaveBeenCalledWith(tx, "u1");
    expect(tx.update.mock.invocationCallOrder[0]!).toBeLessThan(
      mockTrustHost.mock.invocationCallOrder[0]!,
    );
  });

  it("reports an account whose tier was already elevated as trusted", async () => {
    const { db } = buildTxDb(
      { candidateVerifiedAt: new Date(), recruiterVerifiedAt: null },
      "elevated",
    );

    expect((await markRoleAsVerified("u1", "recruiter", null, db as never)).hostTrusted).toBe(true);
  });

  it("throws role_already_verified when target role is already verified", async () => {
    const { db } = buildTxDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });

    await expect(
      markRoleAsVerified("u1", "candidate", candidateProfileFixture, db as never),
    ).rejects.toMatchObject({
      code: "role_already_verified",
      status: 409,
    });
  });

  it("throws user_not_found when the row does not exist", async () => {
    const { db } = buildTxDb(null);

    await expect(
      markRoleAsVerified("u1", "candidate", candidateProfileFixture, db as never),
    ).rejects.toBeInstanceOf(RoleVerificationError);
  });

  // The tier is an expression that keeps a higher tier, never the plain value minimal.
  it("writes the recruiter timestamp and a tier expression in one update when flipping recruiter to verified", async () => {
    const { db, updateChain } = buildTxDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });

    await markRoleAsVerified("u1", "recruiter", null, db as never);

    expect(updateChain.set).toHaveBeenCalledTimes(1);
    const setArg = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("recruiterVerifiedAt");
    expect(setArg).toHaveProperty("recruiterVerificationTier");
    expect(setArg.recruiterVerificationTier).not.toBe("minimal");
  });

  it("does NOT touch recruiterVerificationTier when flipping candidate to verified", async () => {
    const { db, updateChain } = buildTxDb({
      candidateVerifiedAt: null,
      recruiterVerifiedAt: new Date(),
    });

    await markRoleAsVerified("u1", "candidate", candidateProfileFixture, db as never);

    const setArg = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("candidateVerifiedAt");
    expect(setArg).not.toHaveProperty("recruiterVerificationTier");
    expect(mockTrustHost).not.toHaveBeenCalled();
  });
});
