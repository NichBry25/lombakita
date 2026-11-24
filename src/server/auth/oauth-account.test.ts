// @vitest-environment node
//
// Step 6.5d — OAuth account resolver / finalizer tests. Covers the three signIn cases, the
// CHECK-trap (new user writes no row before role declaration), safe-link fail-closed denial,
// suspension on the OAuth path, verification-not-from-Google, the participant-only sign-up, and the
// finalize transaction shape.

import { DrizzleQueryError } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "http://localhost:3000" } }));
vi.mock("@/config/env.server", () => ({
  serverEnv: {
    authSecret: "test-auth-secret",
    appBaseUrl: "http://localhost:3000",
    authUrl: "http://localhost:3000",
  },
}));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({ db: "unused" })) }));

// Cross-session takeover guard (post-incident fix). The signIn flow reads the live JWT cookie
// via cookies() + decode() to detect when an active session belongs to a different user than the
// OAuth identity would resolve to. Tests below stub these to simulate "no session", "matching
// session", and "different active user". Default = no session → all pre-existing tests unaffected.
/* eslint-disable @typescript-eslint/no-unused-vars */
const { cookieStore, decodeMock } = vi.hoisted(() => ({
  cookieStore: { get: vi.fn((_name: string) => undefined as { value: string } | undefined) },
  decodeMock: vi.fn(async (_args: unknown) => null as { sub?: string } | null),
}));
/* eslint-enable @typescript-eslint/no-unused-vars */
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));
vi.mock("next-auth/jwt", () => ({
  decode: decodeMock,
}));
const setActiveSession = (userId: string | null) => {
  if (userId === null) {
    cookieStore.get.mockReturnValue(undefined);
    decodeMock.mockResolvedValue(null);
    return;
  }
  cookieStore.get.mockImplementation((name: string) =>
    name === "next-auth.session-token" ? { value: "fake-jwt" } : undefined,
  );
  decodeMock.mockResolvedValue({ sub: userId });
};

// Step 6.5e — claim-at-signup runs inside the finalize transaction. Mock it so the finalize tx stub
// (which has no .update) is unaffected, and assert the wiring separately.
const { claimPendingInvitationsForUser } = vi.hoisted(() => ({
  claimPendingInvitationsForUser: vi.fn().mockResolvedValue({
    institutionInvitationsClaimed: 0,
    teamInvitationsClaimed: 0,
  }),
}));
vi.mock("@/server/invitations/claim-service", () => ({ claimPendingInvitationsForUser }));

// Step 6.5-HARDENING.1 — the single-use carrier consume runs inside authorizeOAuthFinalize before
// finalizeOAuthSignup. Default: first use (returns true) so pre-existing finalize tests are
// unaffected; individual tests override it to simulate a replay (false) or a fail-closed Redis error
// (throws).
const { consumeSingleUseTokenMock } = vi.hoisted(() => ({
  consumeSingleUseTokenMock: vi.fn(async () => true as boolean),
}));
vi.mock("@/server/redis/rate-limit", () => ({
  consumeSingleUseToken: consumeSingleUseTokenMock,
}));

import {
  accounts as accountsRef,
  candidateProfiles as candidateProfilesRef,
  recruiterVerificationSubmissions as recruiterVerificationSubmissionsRef,
  users as usersRef,
} from "@/server/db/schema";
import {
  authorizeOAuthFinalize,
  finalizeOAuthSignup,
  OAuthFinalizeError,
  resolveGoogleOAuthSignIn,
  resolveGoogleSignIn,
} from "@/server/auth/oauth-account";
import {
  signGoogleIdentityCarrier,
  verifyGoogleIdentityCarrier,
  type GoogleIdentityClaims,
} from "@/server/auth/oauth-identity-carrier";

// Read-only db: distinguishes the accounts-linked probe from the users probe by table identity.
// Only one users query runs per resolve call, so a single usersRows list is sufficient.
const makeReadDb = (
  accountsRows: unknown[],
  usersRows: unknown[],
): { db: unknown; insertCalled: () => boolean } => {
  let insertCalled = false;
  const db = {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn((table: unknown) => {
        chain._table = table;
        return chain;
      });
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() =>
        Promise.resolve(chain._table === accountsRef ? accountsRows : usersRows),
      );
      return chain;
    }),
    // Presence of these would indicate an unexpected write on a read path.
    insert: vi.fn(() => {
      insertCalled = true;
      throw new Error("unexpected insert on read path");
    }),
    transaction: vi.fn(() => {
      insertCalled = true;
      throw new Error("unexpected transaction on read path");
    }),
  };
  return { db, insertCalled: () => insertCalled };
};

const googleClaims: GoogleIdentityClaims = {
  provider: "google",
  providerAccountId: "google-sub-1",
  email: "user@example.com",
  emailVerified: true,
  name: "User Example",
  image: null,
};

afterEach(() => {
  vi.clearAllMocks();
  setActiveSession(null);
});

describe("resolveGoogleSignIn — three OAuth cases + safe-link", () => {
  it("existing linked account → existing_linked (suspension surfaced)", async () => {
    const { db } = makeReadDb([{ userId: "u1" }], [{ id: "u1", suspendedAt: null }]);
    const decision = await resolveGoogleSignIn(
      { providerAccountId: "google-sub-1", email: "user@example.com", googleEmailVerified: true },
      db as never,
    );
    expect(decision).toEqual({ kind: "existing_linked", userId: "u1", suspended: false });
  });

  it("existing linked + suspended → existing_linked with suspended true", async () => {
    const { db } = makeReadDb([{ userId: "u1" }], [{ id: "u1", suspendedAt: new Date() }]);
    const decision = await resolveGoogleSignIn(
      { providerAccountId: "google-sub-1", email: "user@example.com", googleEmailVerified: true },
      db as never,
    );
    expect(decision).toEqual({ kind: "existing_linked", userId: "u1", suspended: true });
  });

  it("existing same-email account, both sides verified → link_existing", async () => {
    const { db } = makeReadDb([], [{ id: "u2", emailVerified: new Date(), suspendedAt: null }]);
    const decision = await resolveGoogleSignIn(
      { providerAccountId: "google-sub-1", email: "user@example.com", googleEmailVerified: true },
      db as never,
    );
    expect(decision).toEqual({ kind: "link_existing", userId: "u2", suspended: false });
  });

  it("safe-link fails closed when the existing account is NOT email-verified", async () => {
    const { db } = makeReadDb([], [{ id: "u2", emailVerified: null, suspendedAt: null }]);
    const decision = await resolveGoogleSignIn(
      { providerAccountId: "google-sub-1", email: "user@example.com", googleEmailVerified: true },
      db as never,
    );
    expect(decision).toEqual({ kind: "link_denied" });
  });

  it("safe-link fails closed when Google email_verified is false", async () => {
    const { db } = makeReadDb([], [{ id: "u2", emailVerified: new Date(), suspendedAt: null }]);
    const decision = await resolveGoogleSignIn(
      { providerAccountId: "google-sub-1", email: "user@example.com", googleEmailVerified: false },
      db as never,
    );
    expect(decision).toEqual({ kind: "link_denied" });
  });

  it("no linked account and no existing email → new_user (defer creation)", async () => {
    const { db, insertCalled } = makeReadDb([], []);
    const decision = await resolveGoogleSignIn(
      { providerAccountId: "google-sub-1", email: "new@example.com", googleEmailVerified: true },
      db as never,
    );
    expect(decision).toEqual({ kind: "new_user" });
    // The CHECK trap: deciding "new_user" writes nothing.
    expect(insertCalled()).toBe(false);
  });
});

describe("resolveGoogleOAuthSignIn — signIn-callback outcome", () => {
  it("new user → redirect to the role picker carrying a VERIFIABLE carrier, zero writes", async () => {
    const { db, insertCalled } = makeReadDb([], []);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "new@example.com",
        googleEmailVerified: true,
        name: "New User",
        image: null,
      },
      db as never,
    );

    expect(typeof outcome).toBe("string");
    const redirect = outcome as string;
    expect(redirect).toContain("/auth/login?oauth=");
    expect(insertCalled()).toBe(false);

    // The carrier embedded in the redirect must verify back to the same Google identity — proving
    // it is the integrity-protected attestation the finalize step will trust.
    const carrier = decodeURIComponent(redirect.split("oauth=")[1] ?? "");
    const claims = verifyGoogleIdentityCarrier(carrier);
    expect(claims?.email).toBe("new@example.com");
    expect(claims?.providerAccountId).toBe("google-sub-1");
    expect(claims?.emailVerified).toBe(true);
  });

  it("suspended existing user → /suspended, never an authenticated session", async () => {
    const { db } = makeReadDb([{ userId: "u1" }], [{ id: "u1", suspendedAt: new Date() }]);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "user@example.com",
        googleEmailVerified: true,
        name: null,
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe("http://localhost:3000/suspended");
  });

  it("existing linked, not suspended → true (proceed)", async () => {
    const { db } = makeReadDb([{ userId: "u1" }], [{ id: "u1", suspendedAt: null }]);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "user@example.com",
        googleEmailVerified: true,
        name: null,
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe(true);
  });

  it("safe-link denied → non-leaking login deny redirect", async () => {
    const { db } = makeReadDb([], [{ id: "u2", emailVerified: null, suspendedAt: null }]);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "user@example.com",
        googleEmailVerified: true,
        name: null,
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe("http://localhost:3000/auth/login?error=oauth_link_denied");
  });

  it("missing Google email → fail closed (deny), no resolve write", async () => {
    const { db, insertCalled } = makeReadDb([], []);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: null,
        googleEmailVerified: true,
        name: null,
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe("http://localhost:3000/auth/login?error=oauth_link_denied");
    expect(insertCalled()).toBe(false);
  });

  it("refuses a new Google sign-up whose address Google has not verified, issuing no carrier", async () => {
    const { db, insertCalled } = makeReadDb([], []);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "new.google@example.test",
        googleEmailVerified: false,
        name: null,
        image: null,
      },
      db as never,
    );

    expect(outcome).toBe("http://localhost:3000/auth/login?error=oauth_email_unverified");
    expect(outcome).not.toContain("oauth=");
    expect(insertCalled()).toBe(false);
  });

  it("still signs in an already linked Google account when Google reports the address unverified", async () => {
    const { db } = makeReadDb([{ userId: "u1" }], [{ id: "u1", suspendedAt: null }]);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "user@example.com",
        googleEmailVerified: false,
        name: null,
        image: null,
      },
      db as never,
    );

    expect(outcome).toBe(true);
  });
});

// Regression coverage for the cross-session takeover incident.
//
// Repro of the original defect: user A had an active JWT cookie. User picked B's Google account
// in the picker. Our resolver returned link_existing (target = B). signIn returned true. next-
// auth's callback-handler.js (lines 135-150) saw the active session as A, found B's Google sub
// unlinked, and called linkAccount({sub_B, userId: A.id}) — silently attaching B's Google sub
// to A's row. The next time B tried Google sign-in, getUserByAccount(sub_B) returned A, and B
// was signed in as A. Fix: refuse the OAuth flow whenever the active session user does not
// equal the resolver's target user, AND refuse a new-user signup while any session is active.
describe("resolveGoogleOAuthSignIn — cross-session takeover guard", () => {
  it("link_existing while a DIFFERENT user is signed in → refuse, do not proceed", async () => {
    setActiveSession("u-attacker");
    const { db } = makeReadDb(
      [],
      // Same-email account; both sides verified → resolver picks link_existing for u-victim.
      [{ id: "u-victim", emailVerified: new Date(), suspendedAt: null }],
    );
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-victim",
        email: "victim@example.com",
        googleEmailVerified: true,
        name: null,
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe("http://localhost:3000/auth/login?error=oauth_session_mismatch");
  });

  it("existing_linked while a DIFFERENT user is signed in → refuse, do not proceed", async () => {
    setActiveSession("u-other");
    const { db } = makeReadDb([{ userId: "u-owner" }], [{ id: "u-owner", suspendedAt: null }]);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "owner@example.com",
        googleEmailVerified: true,
        name: null,
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe("http://localhost:3000/auth/login?error=oauth_session_mismatch");
  });

  it("existing_linked while the SAME user is signed in → proceeds (true)", async () => {
    setActiveSession("u-same");
    const { db } = makeReadDb([{ userId: "u-same" }], [{ id: "u-same", suspendedAt: null }]);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "same@example.com",
        googleEmailVerified: true,
        name: null,
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe(true);
  });

  it("link_existing while the SAME user is signed in → proceeds (true)", async () => {
    setActiveSession("u-same");
    const { db } = makeReadDb([], [{ id: "u-same", emailVerified: new Date(), suspendedAt: null }]);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "same@example.com",
        googleEmailVerified: true,
        name: null,
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe(true);
  });

  it("new_user while ANY session is active → refuse (would surprise the operator)", async () => {
    setActiveSession("u-signed-in");
    const { db, insertCalled } = makeReadDb([], []);
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-new",
        email: "new@example.com",
        googleEmailVerified: true,
        name: "New User",
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe("http://localhost:3000/auth/login?error=oauth_session_mismatch");
    expect(insertCalled()).toBe(false);
  });

  it("suspended target takes precedence over session-mismatch redirect", async () => {
    // A suspended owner must always be routed to /suspended, regardless of active-session
    // state — masking suspension behind a generic mismatch error would invite confusion and
    // potentially leak the wrong remedy hint.
    setActiveSession("u-other");
    const { db } = makeReadDb(
      [{ userId: "u-owner" }],
      [{ id: "u-owner", suspendedAt: new Date() }],
    );
    const outcome = await resolveGoogleOAuthSignIn(
      {
        providerAccountId: "google-sub-1",
        email: "owner@example.com",
        googleEmailVerified: true,
        name: null,
        image: null,
      },
      db as never,
    );
    expect(outcome).toBe("http://localhost:3000/suspended");
  });
});

// Transaction stub for finalizeOAuthSignup: every select resolves [] (not linked / email free /
// username available), captures the users + accounts insert values.
const makeFinalizeDb = () => {
  const captures: {
    userInsert: Record<string, unknown> | null;
    accountInsert: Record<string, unknown> | null;
    candidateProfileInsert: Record<string, unknown> | null;
    recruiterVerificationInsert: Record<string, unknown> | null;
  } = {
    userInsert: null,
    accountInsert: null,
    candidateProfileInsert: null,
    recruiterVerificationInsert: null,
  };

  const tx = {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve([]));
      return chain;
    }),
    insert: vi.fn((table: unknown) => {
      const isUsers = table === usersRef;
      const isAccounts = table === accountsRef;
      const isCandidateProfile = table === candidateProfilesRef;
      const isRecruiterVerification = table === recruiterVerificationSubmissionsRef;
      const chain: Record<string, unknown> = {};
      chain.values = vi.fn((v: Record<string, unknown>) => {
        if (isUsers) captures.userInsert = v;
        if (isAccounts) captures.accountInsert = v;
        if (isCandidateProfile) captures.candidateProfileInsert = v;
        if (isRecruiterVerification) captures.recruiterVerificationInsert = v;
        return chain;
      });
      chain.returning = vi.fn(() =>
        Promise.resolve([{ id: "new-oauth-id", email: captures.userInsert?.email }]),
      );
      chain.onConflictDoNothing = vi.fn(() => Promise.resolve(undefined));
      chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
      return chain;
    }),
  };

  const db = { transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) };
  return { db, captures };
};

const makeFinalizeDbWithFailingInsert = () => {
  const driverFailure = new DrizzleQueryError(
    'insert into "users"',
    [],
    new postgres.PostgresError({
      message: "duplicate key value violates unique constraint",
      code: "23505",
      constraint_name: "users_email_unique",
    } as never),
  );

  const tx = {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve([]));
      return chain;
    }),
    insert: vi.fn((table: unknown) => {
      const isUsers = table === usersRef;
      const chain: Record<string, unknown> = {};
      chain.values = vi.fn(() => chain);
      chain.returning = vi.fn(() =>
        isUsers
          ? Promise.reject(driverFailure)
          : Promise.resolve([{ id: "new-oauth-id", email: "user@example.com" }]),
      );
      chain.onConflictDoNothing = vi.fn(() => Promise.resolve(undefined));
      chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
      return chain;
    }),
  };

  const db = { transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) };
  return { db };
};

// Candidate onboarding fields written in the finalize transaction (parity with credentials signup).
const candidateProfileFixture = {
  fullName: "Dinda Putri",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
} as const;

describe("finalizeOAuthSignup — transactional creation, verification never from Google", () => {
  it("creates a candidate with role-sourced verification + Google-verified Auth.js email column", async () => {
    const { db, captures } = makeFinalizeDb();
    const result = await finalizeOAuthSignup(googleClaims, candidateProfileFixture, db as never);

    expect(result).toEqual({ id: "new-oauth-id", email: "user@example.com", role: "candidate" });
    const u = captures.userInsert;
    expect(u?.candidateVerifiedAt).toBeInstanceOf(Date);
    expect(u?.recruiterVerifiedAt).toBeNull();
    expect(u).not.toHaveProperty("recruiterVerificationTier");
    expect(u?.role).toBe("candidate");
    // Auth.js account-email column reflects Google's email_verified; NOT a role timestamp.
    expect(u?.emailVerified).toBeInstanceOf(Date);
    // accounts row links the Google identity.
    expect(captures.accountInsert).toMatchObject({
      provider: "google",
      providerAccountId: "google-sub-1",
      type: "oauth",
    });
    // Candidate onboarding profile is written in the SAME transaction (parity with credentials).
    expect(captures.candidateProfileInsert).toMatchObject({
      userId: "new-oauth-id",
      fullName: "Dinda Putri",
      phoneNumber: "0812345678",
      occupation: "college_student",
      dateOfBirth: "2000-01-15",
    });
  });

  it("treats a unique violation found on the error's cause as an account conflict", async () => {
    const { db } = makeFinalizeDbWithFailingInsert();

    await expect(
      finalizeOAuthSignup(googleClaims, candidateProfileFixture, db as never),
    ).rejects.toMatchObject({ code: "account_conflict" });
  });

  it("refuses to create an account when Google has not verified the address", async () => {
    const { db, captures } = makeFinalizeDb();

    await expect(
      finalizeOAuthSignup(
        { ...googleClaims, emailVerified: false },
        candidateProfileFixture,
        db as never,
      ),
    ).rejects.toMatchObject({ code: "email_unverified" });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(captures.userInsert).toBeNull();
  });

  it("Step 6.5e — claims pending invitations inside the finalize transaction (Google pre-verified)", async () => {
    const { db } = makeFinalizeDb();
    await finalizeOAuthSignup(googleClaims, candidateProfileFixture, db as never);
    expect(claimPendingInvitationsForUser).toHaveBeenCalledWith(
      "new-oauth-id",
      "user@example.com",
      expect.anything(),
      expect.any(Date),
    );
  });

  it("Step 6.5e (D1) — does NOT claim when Google email_verified is false (verified-email boundary)", async () => {
    const { db } = makeFinalizeDb();
    await expect(
      finalizeOAuthSignup(
        { ...googleClaims, emailVerified: false },
        candidateProfileFixture,
        db as never,
      ),
    ).rejects.toMatchObject({ code: "email_unverified" });
    expect(claimPendingInvitationsForUser).not.toHaveBeenCalled();
  });
});

describe("authorizeOAuthFinalize — carrier gate", () => {
  it("rejects an invalid/tampered carrier with invalid_carrier", async () => {
    await expect(
      authorizeOAuthFinalize({ carrier: "forged.token", role: "candidate" }),
    ).rejects.toMatchObject({ code: "invalid_carrier" });
  });

  it("finalizes with a valid carrier + role, consuming the carrier nonce exactly once", async () => {
    const { db } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);
    const result = await authorizeOAuthFinalize(
      { carrier, role: "candidate", ...candidateProfileFixture },
      db as never,
    );
    expect(result).toMatchObject({ id: "new-oauth-id", role: "candidate" });
    expect(consumeSingleUseTokenMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a replayed carrier (nonce already consumed) with carrier_replayed and does not finalize", async () => {
    consumeSingleUseTokenMock.mockResolvedValueOnce(false);
    const { db, captures } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);

    await expect(
      authorizeOAuthFinalize(
        { carrier, role: "candidate", ...candidateProfileFixture },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "carrier_replayed", message: "oauth_carrier_replayed" });
    // Fail closed before any account write.
    expect(captures.userInsert).toBeNull();
  });

  it("fails closed (carrier_replayed) when the single-use store cannot confirm (Redis error)", async () => {
    consumeSingleUseTokenMock.mockRejectedValueOnce(new Error("redis down"));
    const { db, captures } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);

    await expect(
      authorizeOAuthFinalize(
        { carrier, role: "candidate", ...candidateProfileFixture },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "carrier_replayed", message: "oauth_carrier_unavailable" });
    expect(captures.userInsert).toBeNull();
  });

  it("refuses an unverified Google carrier with email_unverified and writes nothing", async () => {
    const { db, captures } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier({ ...googleClaims, emailVerified: false });

    await expect(
      authorizeOAuthFinalize(
        { carrier, role: "candidate", ...candidateProfileFixture },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "email_unverified" });
    expect(captures.userInsert).toBeNull();
  });

  it("OAuthFinalizeError is the thrown type", async () => {
    await expect(
      authorizeOAuthFinalize({ carrier: "bad", role: "candidate" }),
    ).rejects.toBeInstanceOf(OAuthFinalizeError);
  });

  it("rejects a finalize whose participant details are missing, before touching the DB or the carrier nonce", async () => {
    const { db, captures } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);

    await expect(
      authorizeOAuthFinalize(
        { carrier, role: "recruiter", fullName: "Wisnu Aditya", mobileNumber: "0813456789" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_candidate_profile" });

    expect(captures.userInsert).toBeNull();
    expect(consumeSingleUseTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a finalize with an invalid phone number before the carrier nonce", async () => {
    const { db, captures } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);

    await expect(
      authorizeOAuthFinalize(
        { carrier, ...candidateProfileFixture, phoneNumber: "123" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_candidate_profile" });

    expect(captures.userInsert).toBeNull();
    expect(consumeSingleUseTokenMock).not.toHaveBeenCalled();
  });

  it("finalizes a participant-only account from a Google sign-up that asks for the host role", async () => {
    const { db, captures } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);

    const result = await authorizeOAuthFinalize(
      {
        carrier,
        role: "recruiter",
        ...candidateProfileFixture,
        mobileNumber: "0899999999",
        corporateEmail: "attacker@corp.co.id",
      },
      db as never,
    );

    expect(result).toMatchObject({ id: "new-oauth-id", role: "candidate" });
    expect(captures.userInsert?.role).toBe("candidate");
    expect(captures.userInsert?.recruiterVerifiedAt).toBeNull();
    expect(captures.candidateProfileInsert).toMatchObject({
      userId: "new-oauth-id",
      fullName: "Dinda Putri",
    });
    expect(captures.recruiterVerificationInsert).toBeNull();
  });
});
