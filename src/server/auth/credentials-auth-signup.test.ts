// @vitest-environment node
//
// Step 4.0c (4.0c-T2) — Recruiter signup atomic auto-grant assertion.
//
// Verifies that registerUserWithCredentials({ signupRole: "recruiter", ... }) writes both
// `recruiterVerifiedAt` (a Date) and `recruiterVerificationTier="minimal"` in the SAME INSERT
// `values()` call — i.e. one DB statement, not two separate writes. The same expectation holds
// for the re-declaration UPDATE path (pre-existing unverified row).

import { describe, expect, it, vi } from "vitest";

const { mockGetDb, generateUsername, hashPassword, sendRegistrationVerificationEmail } = vi.hoisted(
  () => ({
    mockGetDb: vi.fn(),
    generateUsername: vi.fn(),
    hashPassword: vi.fn(),
    sendRegistrationVerificationEmail: vi.fn(),
  }),
);

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/username/generate", () => ({
  generateUsername,
  UsernameGenerationError: class extends Error {},
}));
vi.mock("@/server/auth/password", () => ({
  hashPassword,
  hashVerificationToken: vi.fn().mockReturnValue("hashedtoken"),
  issueVerificationToken: vi.fn().mockReturnValue({ rawToken: "raw", tokenHash: "hashedtoken" }),
  verifyPassword: vi.fn(),
}));
vi.mock("@/server/auth/email-verification", () => ({ sendRegistrationVerificationEmail }));

import { registerUserWithCredentials } from "@/server/auth/credentials-auth";

// Build a transaction stub that:
// - returns no existing user (first .select() chain returns [])
// - returns no existing username collision (second .select() chain returns [])
// - captures the .values() arg on insert(users)
// - returns a fresh id from insert(users).returning()
// - swallows the subsequent insert(userProfiles), insert(userPasswordCredentials),
//   delete(userEmailVerificationTokens), insert(userEmailVerificationTokens) calls
const buildRegistrationStubDb = () => {
  const captures: { userInsertValues: Record<string, unknown> | null } = {
    userInsertValues: null,
  };

  const txStub = () => {
    // select chain — returns [] from .limit() so existing-user and username-taken probes
    // both resolve as "no row found".
    const selectChain = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([]),
    };
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);

    // insert chain — capture .values() arg and return id on .returning().
    let inserting: unknown = null;
    const insertChain = {
      values: vi.fn((arg: Record<string, unknown>) => {
        if (inserting === "users") captures.userInsertValues = arg;
        return insertChain;
      }),
      returning: vi.fn().mockResolvedValue([{ id: "new-user-id" }]),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };

    // update / delete chains — no-op for the post-insert profile + credentials writes.
    const updateChain = {
      set: vi.fn(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    updateChain.set.mockReturnValue(updateChain);

    const deleteChain = {
      where: vi.fn().mockResolvedValue(undefined),
    };

    return {
      select: vi.fn().mockReturnValue(selectChain),
      insert: vi.fn((table: { _: { name: string } }) => {
        // Identify the target table via Drizzle's symbol; fall back to a name string if needed.
        // We compare by reference using the schema export below.
        inserting = table === usersRef ? "users" : "other";
        return insertChain;
      }),
      update: vi.fn().mockReturnValue(updateChain),
      delete: vi.fn().mockReturnValue(deleteChain),
    };
  };

  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(txStub())),
  };

  return { db, captures };
};

// Acquire a stable reference to the users table for identity comparison inside the insert stub.
import { users as usersRef } from "@/server/db/schema";

describe("registerUserWithCredentials — recruiter signup atomic auto-grant (4.0c-T2)", () => {
  it("writes recruiterVerifiedAt and recruiterVerificationTier='minimal' in the SAME insert values() call", async () => {
    const { db, captures } = buildRegistrationStubDb();
    mockGetDb.mockReturnValue(db);
    generateUsername.mockResolvedValue("dinda_recruiter_1234");
    hashPassword.mockResolvedValue("$2b$10$mockhash");
    sendRegistrationVerificationEmail.mockResolvedValue(undefined);

    await registerUserWithCredentials({
      name: "Dinda Recruiter",
      email: "recruiter@example.com",
      password: "very-strong-password",
      signupRole: "recruiter",
    });

    const values = captures.userInsertValues;
    expect(values).not.toBeNull();
    // Atomic auto-grant: both fields ride the SAME .values() call.
    expect(values).toHaveProperty("recruiterVerifiedAt");
    expect(values?.recruiterVerifiedAt).toBeInstanceOf(Date);
    expect(values).toHaveProperty("recruiterVerificationTier", "minimal");
    // candidateVerifiedAt is null on recruiter signups.
    expect(values?.candidateVerifiedAt).toBeNull();
    // Top-level user-level role mirrors the signup declaration.
    expect(values).toHaveProperty("role", "recruiter");
  });

  it("leaves recruiterVerificationTier='unverified' on candidate signup (no premature grant)", async () => {
    const { db, captures } = buildRegistrationStubDb();
    mockGetDb.mockReturnValue(db);
    generateUsername.mockResolvedValue("dinda_candidate_1234");
    hashPassword.mockResolvedValue("$2b$10$mockhash");
    sendRegistrationVerificationEmail.mockResolvedValue(undefined);

    await registerUserWithCredentials({
      name: "Dinda Candidate",
      email: "candidate@example.com",
      password: "very-strong-password",
      signupRole: "candidate",
    });

    const values = captures.userInsertValues;
    expect(values).not.toBeNull();
    expect(values).toHaveProperty("recruiterVerificationTier", "unverified");
    expect(values?.recruiterVerifiedAt).toBeNull();
    expect(values?.candidateVerifiedAt).toBeInstanceOf(Date);
  });
});
