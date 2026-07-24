// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

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

  // Recruiter affiliation form written in the same transaction as the recruiter grant, entering
  // the account into the platform-ops trust review queue.
  const recruiterVerificationFixture = {
    fullName: "Rendra Wijaya",
    mobileNumber: "0812345678",
    corporateEmail: "rendra@corp.co.id",
  } as const;

  // Helper that produces a tx with a select returning `row`, a no-op update().set().where(), and
  // an insert().values() chain that captures the onboarding write (candidate profile upsert or
  // recruiter submission insert).
  const buildTxDb = (row: unknown | null) => {
    const selectChain = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue(row === null ? [] : [row]),
    };
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);

    const updateChain = {
      set: vi.fn(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    updateChain.set.mockReturnValue(updateChain);

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
      null,
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

    await expect(markRoleAsVerified("u1", "candidate", null, null, db as never)).rejects.toMatchObject(
      {
        code: "candidate_profile_required",
        status: 400,
      },
    );
    // Fail closed before opening the transaction.
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("throws recruiter_verification_required when verifying recruiter with no affiliation form", async () => {
    const { db, tx } = buildTxDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });

    await expect(markRoleAsVerified("u1", "recruiter", null, null, db as never)).rejects.toMatchObject({
      code: "recruiter_verification_required",
      status: 400,
    });
    // Fail closed before opening the transaction.
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("writes the recruiter trust submission in the same transaction as the recruiter grant", async () => {
    const { db, captures } = buildTxDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });

    await markRoleAsVerified("u1", "recruiter", null, recruiterVerificationFixture, db as never);

    expect(captures.candidateProfileInsert).toMatchObject({
      userId: "u1",
      fullName: "Rendra Wijaya",
      mobileNumber: "0812345678",
      corporateEmail: "rendra@corp.co.id",
      emailDomainFlag: true,
    });
  });

  it("throws role_already_verified when target role is already verified", async () => {
    const { db } = buildTxDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });

    await expect(
      markRoleAsVerified("u1", "candidate", candidateProfileFixture, null, db as never),
    ).rejects.toMatchObject({
      code: "role_already_verified",
      status: 409,
    });
  });

  it("throws user_not_found when the row does not exist", async () => {
    const { db } = buildTxDb(null);

    await expect(
      markRoleAsVerified("u1", "candidate", candidateProfileFixture, null, db as never),
    ).rejects.toBeInstanceOf(RoleVerificationError);
  });

  // Step 4.0c (4.0c-T3) — When the second-role stub flips recruiter to verified, the
  // recruiter_verification_tier must be lifted to 'minimal' in the SAME UPDATE statement.
  // Otherwise the row would land at recruiter_verified_at IS NOT NULL AND tier='unverified',
  // which is the 4.0c-M1 inconsistency now prevented by both the application fix and the
  // users_recruiter_tier_consistency_chk DB constraint.
  it("sets recruiterVerificationTier='minimal' atomically when flipping recruiter to verified (4.0c-M1 fix)", async () => {
    const { db, updateChain } = buildTxDb({
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: null,
    });

    await markRoleAsVerified("u1", "recruiter", null, recruiterVerificationFixture, db as never);

    // Both writes must land in a single .set() call — the helper only invokes update().set()
    // once per call, so the assertion below confirms both fields ride the same statement.
    expect(updateChain.set).toHaveBeenCalledTimes(1);
    const setArg = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("recruiterVerifiedAt");
    expect(setArg).toHaveProperty("recruiterVerificationTier", "minimal");
  });

  it("does NOT touch recruiterVerificationTier when flipping candidate to verified", async () => {
    const { db, updateChain } = buildTxDb({
      candidateVerifiedAt: null,
      recruiterVerifiedAt: new Date(),
    });

    await markRoleAsVerified("u1", "candidate", candidateProfileFixture, null, db as never);

    const setArg = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("candidateVerifiedAt");
    expect(setArg).not.toHaveProperty("recruiterVerificationTier");
  });
});
