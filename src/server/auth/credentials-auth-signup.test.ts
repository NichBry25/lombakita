// @vitest-environment node
//
// The users insert of a sign-up: every sign-up writes the participant role and its verification
// timestamp in the one insert, and leaves the recruiter tier to its column default.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/server/auth/registration-code", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/registration-code")>()),
  issueRegistrationCode: () => "123456",
  hashRegistrationCode: (userId: string, code: string) => `hash:${userId}:${code}`,
}));

import {
  registerUserWithCredentials,
  resendRegistrationVerification,
} from "@/server/auth/credentials-auth";

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

describe("registerUserWithCredentials, the users insert of a sign-up", () => {
  it("writes a participant-only account even when the sign-up asks for the host role", async () => {
    const { db, captures } = buildRegistrationStubDb();
    mockGetDb.mockReturnValue(db);
    generateUsername.mockResolvedValue("dinda_recruiter_1234");
    hashPassword.mockResolvedValue("$2b$10$mockhash");
    sendRegistrationVerificationEmail.mockResolvedValue(undefined);

    await registerUserWithCredentials({
      name: "Dinda Putri",
      email: "recruiter@example.com",
      password: "very-strong-password",
      signupRole: "recruiter",
      fullName: "Dinda Putri",
      phoneNumber: "0812345678",
      occupation: "college_student",
      dateOfBirth: "2000-01-15",
      mobileNumber: "0812345678",
      corporateEmail: "dinda@corp.co.id",
    });

    const values = captures.userInsertValues;
    expect(values).not.toBeNull();
    expect(values).toHaveProperty("role", "candidate");
    expect(values?.candidateVerifiedAt).toBeInstanceOf(Date);
    expect(values?.recruiterVerifiedAt).toBeNull();
    expect(values).not.toHaveProperty("recruiterVerificationTier");
  });

  it("writes the participant role and its timestamp in the users insert", async () => {
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
      fullName: "Dinda Candidate",
      phoneNumber: "0812345678",
      occupation: "college_student",
      dateOfBirth: "2000-01-15",
    });

    const values = captures.userInsertValues;
    expect(values).not.toBeNull();
    expect(values).toHaveProperty("role", "candidate");
    expect(values?.candidateVerifiedAt).toBeInstanceOf(Date);
    expect(values?.recruiterVerifiedAt).toBeNull();
    expect(values).not.toHaveProperty("recruiterVerificationTier");
  });
});

const candidateSignupPayload = {
  name: "Dinda Candidate",
  email: "candidate@example.com",
  password: "very-strong-password",
  signupRole: "candidate",
  fullName: "Dinda Candidate",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

const registerCandidateWithReturnAddress = async (callbackUrl: string) => {
  const { db } = buildRegistrationStubDb();
  mockGetDb.mockReturnValue(db);
  generateUsername.mockResolvedValue("dinda_candidate_1234");
  hashPassword.mockResolvedValue("$2b$10$mockhash");
  sendRegistrationVerificationEmail.mockResolvedValue(undefined);

  await registerUserWithCredentials({ ...candidateSignupPayload, callbackUrl });
};

const buildResendStubDb = () => {
  const selectChain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi
      .fn()
      .mockResolvedValueOnce([{ id: "user-1", name: "Dinda Candidate", emailVerified: null }])
      .mockResolvedValueOnce([{ userId: "user-1" }]),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);

  return {
    select: vi.fn().mockReturnValue(selectChain),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  };
};

const resendWithReturnAddress = async (callbackUrl: string) => {
  sendRegistrationVerificationEmail.mockResolvedValue(undefined);
  const db = buildResendStubDb();

  await resendRegistrationVerification(
    { email: "candidate@example.com", callbackUrl },
    db as unknown as Parameters<typeof resendRegistrationVerification>[1],
  );
};

describe("the verification email of a sign-up that carries a return address", () => {
  beforeEach(() => {
    sendRegistrationVerificationEmail.mockClear();
  });

  it("sends only the address and the code after a sign-up", async () => {
    await registerCandidateWithReturnAddress("/competitions/acme/lomba-1");

    expect(sendRegistrationVerificationEmail).toHaveBeenCalledTimes(1);
    expect(sendRegistrationVerificationEmail).toHaveBeenCalledWith({
      email: "candidate@example.com",
      code: "123456",
    });
  });

  it("sends only the address and the code after a resend", async () => {
    await resendWithReturnAddress("/competitions/acme/lomba-1");

    expect(sendRegistrationVerificationEmail).toHaveBeenCalledTimes(1);
    expect(sendRegistrationVerificationEmail).toHaveBeenCalledWith({
      email: "candidate@example.com",
      code: "123456",
    });
  });
});
