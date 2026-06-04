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

  it("finalizes with a valid carrier + role", async () => {
    const { db } = makeFinalizeDb();
    const carrier = signGoogleIdentityCarrier(googleClaims);
    const result = await authorizeOAuthFinalize({ carrier, role: "candidate" }, db as never);
    expect(result).toMatchObject({ id: "new-oauth-id", role: "candidate" });
  });

  it("OAuthFinalizeError is the thrown type", async () => {
    await expect(
      authorizeOAuthFinalize({ carrier: "bad", role: "candidate" }),
    ).rejects.toBeInstanceOf(OAuthFinalizeError);
  });
});
