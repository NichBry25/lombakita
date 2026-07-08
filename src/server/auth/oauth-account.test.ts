// @vitest-environment node
//
// Step 6.5d — OAuth account resolver / finalizer tests. Covers the three signIn cases, the
// CHECK-trap (new user writes no row before role declaration), safe-link fail-closed denial,
// suspension on the OAuth path, verification-not-from-Google, recruiter tier parity, and the
// finalize transaction shape.

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

import { accounts as accountsRef, users as usersRef } from "@/server/db/schema";
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
    const { db } = makeReadDb(
      [],
      [{ id: "u2", emailVerified: new Date(), suspendedAt: null }],
    );
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
    const { db } = makeReadDb(
      [{ userId: "u-owner" }],
      [{ id: "u-owner", suspendedAt: null }],
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
    const { db } = makeReadDb(
      [],
      [{ id: "u-same", emailVerified: new Date(), suspendedAt: null }],
    );
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
  } = { userInsert: null, accountInsert: null };

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
      const chain: Record<string, unknown> = {};
      chain.values = vi.fn((v: Record<string, unknown>) => {
        if (isUsers) captures.userInsert = v;
        if (isAccounts) captures.accountInsert = v;
        return chain;
      });
      chain.returning = vi.fn(() =>
        Promise.resolve([{ id: "new-oauth-id", email: captures.userInsert?.email }]),
      );
      chain.onConflictDoNothing = vi.fn(() => Promise.resolve(undefined));
      return chain;
    }),
  };

  const db = { transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) };
  return { db, captures };
};

describe("finalizeOAuthSignup — transactional creation, verification never from Google", () => {
  it("creates a candidate with role-sourced verification + Google-verified Auth.js email column", async () => {
    const { db, captures } = makeFinalizeDb();
    const result = await finalizeOAuthSignup(googleClaims, "candidate", db as never);

    expect(result).toEqual({ id: "new-oauth-id", email: "user@example.com", role: "candidate" });
    const u = captures.userInsert;
    expect(u?.candidateVerifiedAt).toBeInstanceOf(Date);
    expect(u?.recruiterVerifiedAt).toBeNull();
    expect(u?.recruiterVerificationTier).toBe("unverified");
    expect(u?.role).toBe("candidate");
    // Auth.js account-email column reflects Google's email_verified; NOT a role timestamp.
    expect(u?.emailVerified).toBeInstanceOf(Date);
    // accounts row links the Google identity.
    expect(captures.accountInsert).toMatchObject({
      provider: "google",
      providerAccountId: "google-sub-1",
      type: "oauth",
    });
  });

  it("sets candidate verification from the DECLARED ROLE even when Google email_verified is false", async () => {
    const { db, captures } = makeFinalizeDb();
    await finalizeOAuthSignup({ ...googleClaims, emailVerified: false }, "candidate", db as never);

    const u = captures.userInsert;
    // Role verification is independent of Google: candidateVerifiedAt is still set.
    expect(u?.candidateVerifiedAt).toBeInstanceOf(Date);
    // The Auth.js email column tracks Google's flag (false → null), proving the two are distinct.
    expect(u?.emailVerified).toBeNull();
  });

  it("grants the recruiter minimal tier on an OAuth recruiter signup (parity with credentials)", async () => {
    const { db, captures } = makeFinalizeDb();
    await finalizeOAuthSignup(googleClaims, "recruiter", db as never);

    const u = captures.userInsert;
    expect(u?.recruiterVerifiedAt).toBeInstanceOf(Date);
    expect(u?.recruiterVerificationTier).toBe("minimal");
    expect(u?.candidateVerifiedAt).toBeNull();
    expect(u?.role).toBe("recruiter");
  });

  it("Step 6.5e — claims pending invitations inside the finalize transaction (Google pre-verified)", async () => {
    const { db } = makeFinalizeDb();
    await finalizeOAuthSignup(googleClaims, "candidate", db as never);
    expect(claimPendingInvitationsForUser).toHaveBeenCalledWith(
      "new-oauth-id",
      "user@example.com",
      expect.anything(),
      expect.any(Date),
    );
  });

  it("Step 6.5e (D1) — does NOT claim when Google email_verified is false (verified-email boundary)", async () => {
    const { db } = makeFinalizeDb();
    await finalizeOAuthSignup({ ...googleClaims, emailVerified: false }, "candidate", db as never);
    expect(claimPendingInvitationsForUser).not.toHaveBeenCalled();
  });
});

describe("authorizeOAuthFinalize — carrier gate", () => {
  it("rejects an invalid/tampered carrier with invalid_carrier", async () => {
    await expect(
      authorizeOAuthFinalize({ carrier: "forged.token", role: "candidate" }),
    ).rejects.toMatchObject({ code: "invalid_carrier" });
  });

  it("rejects a missing/invalid role with invalid_role", async () => {
    const carrier = signGoogleIdentityCarrier(googleClaims);
    await expect(
      authorizeOAuthFinalize({ carrier, role: "platform_ops" }),
    ).rejects.toMatchObject({ code: "invalid_role" });
  });

  it("finalizes with a valid carrier + role, consuming the carrier nonce exactly once", async () => {
    const { db } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);
    const result = await authorizeOAuthFinalize({ carrier, role: "candidate" }, db as never);
    expect(result).toMatchObject({ id: "new-oauth-id", role: "candidate" });
    expect(consumeSingleUseTokenMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a replayed carrier (nonce already consumed) with carrier_replayed and does not finalize", async () => {
    consumeSingleUseTokenMock.mockResolvedValueOnce(false);
    const { db, captures } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);

    await expect(
      authorizeOAuthFinalize({ carrier, role: "candidate" }, db as never),
    ).rejects.toMatchObject({ code: "carrier_replayed", message: "oauth_carrier_replayed" });
    // Fail closed before any account write.
    expect(captures.userInsert).toBeNull();
  });

  it("fails closed (carrier_replayed) when the single-use store cannot confirm (Redis error)", async () => {
    consumeSingleUseTokenMock.mockRejectedValueOnce(new Error("redis down"));
    const { db, captures } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);

    await expect(
      authorizeOAuthFinalize({ carrier, role: "candidate" }, db as never),
    ).rejects.toMatchObject({ code: "carrier_replayed", message: "oauth_carrier_unavailable" });
    expect(captures.userInsert).toBeNull();
  });

  it("OAuthFinalizeError is the thrown type", async () => {
    await expect(
      authorizeOAuthFinalize({ carrier: "bad", role: "candidate" }),
    ).rejects.toBeInstanceOf(OAuthFinalizeError);
  });
});
