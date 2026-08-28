import { DrizzleAdapter } from "@auth/drizzle-adapter";
import * as Sentry from "@sentry/nextjs";
import { eq } from "drizzle-orm";
import type { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { assertRuntimeEnv, serverEnv } from "@/config/env.server";
import { type AppRole, isAppRole, isSelfServiceRole } from "@/lib/access/roles";
import { logger } from "@/lib/logger";
import { authenticateWithEmailPassword, normalizeEmail } from "@/server/auth/credentials-auth";
import { extractClientIp, UNKNOWN_CLIENT_IP } from "@/server/auth/client-ip";
import { LOGIN_FAILED_ATTEMPT_LIMIT } from "@/server/auth/rate-limit-constants";
import {
  authorizeOAuthFinalize,
  GOOGLE_PROVIDER_ID,
  OAUTH_FINALIZE_PROVIDER_ID,
  resolveGoogleOAuthSignIn,
} from "@/server/auth/oauth-account";
import { consumeMfaElevationGrant } from "@/server/auth/mfa/mfa-elevation";
import { hasVerifiedMfaFactorSql } from "@/server/auth/mfa/mfa-factor-sql";
import { resolveMfaStatus } from "@/server/auth/mfa/mfa-status";
import {
  clearFailedAttempts,
  isFailedAttemptLimited,
  recordFailedAttempt,
} from "@/server/redis/rate-limit";
import { getDb } from "@/server/db/client";
import { accounts, sessions, users, verificationTokens } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/auth.config");

assertRuntimeEnv("web");

export const isEmailAuthConfigured = Boolean(serverEnv.resendApiKey && serverEnv.authEmailFrom);

// The Google provider is registered only when both OAuth credentials are present.
// Absent locally → "Sign in with Google" is simply unavailable; credentials sign-in is unaffected.
export const isGoogleAuthConfigured = Boolean(
  serverEnv.googleClientId && serverEnv.googleClientSecret,
);

export const isAuthPersistenceConfigured = Boolean(serverEnv.databaseUrl);

const authAdapter: Adapter | undefined = isAuthPersistenceConfigured
  ? (DrizzleAdapter(getDb(), {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }) as Adapter)
  : undefined;

// Persistent session cookie behaviour.
// Target lifetime is one year. Refresh-on-activity advances the cookie's effective expiry every
// time the session callback fires (each request that resolves the session). Session strategy
// remains "jwt". Termination on explicit logout, password
// change, or server-initiated invalidation is provided by next-auth + AUTH_SECRET rotation.
export const PERSISTENT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

// Per-mode verification state, surfaced as the verifiedRoles array on the
// session. A role is in verifiedRoles iff its corresponding *_verified_at timestamp on the user
// row is non-null (users.candidateVerifiedAt, users.recruiterVerifiedAt;
// DB CHECK users_one_verified_role_chk guarantees at least one is non-null per account).
// Reads are bounded — populated on sign-in, on next-auth update trigger, and once for any
// pre-existing JWT that does not yet carry the field. Degrades to an empty array on DB error
// so a transient DB hiccup never breaks session resolution.
const loadVerifiedRoles = async (userId: string): Promise<AppRole[]> => {
  try {
    const [row] = await getDb()
      .select({
        candidateVerifiedAt: users.candidateVerifiedAt,
        recruiterVerifiedAt: users.recruiterVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) return [];

    const roles: AppRole[] = [];
    if (row.candidateVerifiedAt) roles.push("candidate");
    if (row.recruiterVerifiedAt) roles.push("recruiter");
    return roles;
  } catch (error) {
    logger.error("auth.verifiedRoles.load_failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};

const sanitizeVerifiedRoles = (value: unknown): AppRole[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is AppRole => typeof entry === "string" && isAppRole(entry));
};

// The account's suspension state and its current user-level role are both read from the database
// on every session resolution rather than trusted from the JWT. Under the jwt strategy a token is
// minted at sign-in and never refreshed, so anything cached inside it stays authoritative for the
// cookie's full lifetime (one year); reading these columns live is what makes a suspension or a
// role change take effect on the account's very next request. This adds ONE indexed-PK SELECT per
// session read — the accepted trade-off for immediate effect.
//
// The three outcomes are kept distinct because they require opposite failure behaviour:
//   found       — use the database values.
//   unavailable — the query threw. Callers FAIL OPEN for self-service roles and fall back to the
//                 token's cached role: a transient DB fault must never sign every user out of the
//                 platform, and self-service accounts are the overwhelming majority of sessions.
//   missing     — no users row. Callers FAIL CLOSED and surface no role, so a deleted account's
//                 existing cookie stops authenticating. Deletion is the only cause; a session
//                 never legitimately resolves for an absent user row.
//
// `role` is typed nullable even though users.role is NOT NULL, so an out-of-band write or a future
// schema change that admits a null can only ever produce a roleless session, never a coerced one.
type LiveAccountState =
  | {
      status: "found";
      role: string | null;
      suspendedAt: Date | null;
      // Read in the SAME indexed-PK SELECT as role/suspendedAt: `mfaInvalidatedAt` is
      // one extra projected column on `users` (the DEC-0112 precedent), and `hasVerifiedMfaFactor`
      // is a correlated EXISTS subquery rather than a join — same shape as
      // institutionOwnerAvatarKeySql elsewhere in this codebase. This stays ONE SELECT.
      mfaInvalidatedAt: Date | null;
      hasVerifiedMfaFactor: boolean;
    }
  | { status: "missing" }
  | { status: "unavailable" };

const loadLiveAccountState = async (userId: string): Promise<LiveAccountState> => {
  try {
    const [row] = await getDb()
      .select({
        role: users.role,
        suspendedAt: users.suspendedAt,
        mfaInvalidatedAt: users.mfaInvalidatedAt,
        hasVerifiedMfaFactor: hasVerifiedMfaFactorSql,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) {
      return { status: "missing" };
    }

    return {
      status: "found",
      role: row.role,
      suspendedAt: row.suspendedAt,
      mfaInvalidatedAt: row.mfaInvalidatedAt,
      hasVerifiedMfaFactor: row.hasVerifiedMfaFactor,
    };
  } catch (error) {
    logger.error("auth.liveAccountState.load_failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    Sentry.captureException(error, {
      level: "warning",
      tags: { subsystem: "auth-session", operation: "load_live_account_state" },
    });
    return { status: "unavailable" };
  }
};

// Which role the session should present: the live database value when it is readable, the token's
// cached value when the database is unreachable, and none at all when the account no longer exists.
//
// The unreachable-database fallback is restricted to self-service roles. Operational roles
// (platform_ops, finance_ops) are the ones whose revocation this live read exists to deliver, so
// honouring a cached operational role while the database is down would reopen exactly the window
// being closed. Those sessions fail closed instead and recover on the next successful read.
const resolveEffectiveRole = (
  account: LiveAccountState,
  tokenRole: string | undefined,
): string | undefined => {
  if (account.status === "found") {
    return account.role ?? undefined;
  }
  if (account.status === "unavailable") {
    return isSelfServiceRole(tokenRole) ? tokenRole : undefined;
  }
  return undefined;
};

export const authOptions: NextAuthOptions = {
  adapter: authAdapter,
  session: {
    // DEC-0015: session strategy stays jwt. DEC-0049: cookie lifetime is long-lived (~1y).
    // updateAge controls how often next-auth rewrites the JWT cookie when the session is read.
    // 24h is the standard refresh cadence and produces the LinkedIn/YouTube-style "session
    // survives indefinite idle if the user returns at least once per maxAge window" behaviour.
    strategy: "jwt",
    maxAge: PERSISTENT_SESSION_MAX_AGE_SECONDS,
    updateAge: 60 * 60 * 24,
  },
  jwt: {
    maxAge: PERSISTENT_SESSION_MAX_AGE_SECONDS,
  },
  secret: serverEnv.authSecret,
  pages: {
    signIn: "/auth/login",
  },
  providers: [
    CredentialsProvider({
      name: "email-password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        const emailInput = credentials?.email;
        const passwordInput = credentials?.password;

        if (typeof emailInput !== "string" || typeof passwordInput !== "string") {
          throw new Error("INVALID_CREDENTIALS");
        }

        // Failed-attempt lockout keyed by (client IP + email), evaluated BEFORE any password hashing
        // so a locked-out key does zero crypto work. The over-limit signal is identical whether or
        // not the email exists (no enumeration leak). Fail-open (isFailedAttemptLimited): a Redis
        // outage never locks anyone out. The thrown RATE_LIMITED message propagates to the client via
        // the same next-auth credentials error path as ACCOUNT_SUSPENDED (result.error).
        //
        // The lockout is skipped entirely when the client IP is unresolvable: keying on the sentinel
        // alone would collapse to a single per-email bucket, turning the limiter into a targeted
        // account-lockout of any known email regardless of source. The IP component is what keeps a
        // failed-attempt count attributable; without it, not throttling is the safer choice.
        const headers = (req?.headers ?? {}) as Record<string, unknown>;
        const clientIp = extractClientIp((name) => {
          const value = headers[name];
          return typeof value === "string" ? value : null;
        });
        const loginRateLimitEnforced = clientIp !== UNKNOWN_CLIENT_IP;
        const failedAttemptKey = `${LOGIN_FAILED_ATTEMPT_LIMIT.keyPrefix}${clientIp}:${normalizeEmail(emailInput)}`;

        if (
          loginRateLimitEnforced &&
          (await isFailedAttemptLimited({
            key: failedAttemptKey,
            limit: LOGIN_FAILED_ATTEMPT_LIMIT.limit,
          }))
        ) {
          throw new Error("RATE_LIMITED");
        }

        const result = await authenticateWithEmailPassword(emailInput, passwordInput).catch(() => {
          throw new Error("INVALID_CREDENTIALS");
        });

        // Suspended accounts are blocked here, after the credentials service has
        // confirmed the password. Throwing aborts authorize without returning a user object, so
        // next-auth issues no JWT/session. The thrown message propagates verbatim to the client
        // via next-auth v4's credentials error path (core/routes/callback.js → redirect
        // `?error=<message>` → react signIn `result.error`); the sign-in form maps this distinct
        // signal to a /suspended redirect.
        if (result.status === "account_suspended") {
          throw new Error("ACCOUNT_SUSPENDED");
        }

        if (result.status === "email_not_verified") {
          throw new Error("EMAIL_NOT_VERIFIED");
        }

        if (result.status === "invalid_credentials") {
          // Count only failed password attempts toward the lockout. Suspended / unverified are
          // correct-password outcomes and neither increment nor clear the counter.
          if (loginRateLimitEnforced) {
            await recordFailedAttempt({
              key: failedAttemptKey,
              windowSeconds: LOGIN_FAILED_ATTEMPT_LIMIT.windowSeconds,
            });
          }
          throw new Error("INVALID_CREDENTIALS");
        }

        // Authenticated — clear the counter so a good login resets a partial lockout and successful
        // logins never accumulate toward the limit.
        if (loginRateLimitEnforced) {
          await clearFailedAttempts(failedAttemptKey);
        }

        return {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role,
        };
      },
    }),
    // OAuth finalization provider. A brand-new Google user is routed to the role
    // picker (the signIn callback returns a redirect, so no users row is created by the OAuth
    // adapter). Once a role is declared, the client calls signIn("oauth-finalize", { carrier, role
    // }); authorize verifies the integrity-protected carrier, creates the account transactionally,
    // and returns the user — next-auth then mints a JWT session indistinguishable from a
    // credentials session. This provider performs no password check: its trust anchor is the
    // HMAC-signed carrier, which only our signIn callback can issue after Google authenticated the
    // identity. Kept AFTER the email-password provider so providers[0] remains the credentials
    // login provider for existing tests/integrations.
    CredentialsProvider({
      id: OAUTH_FINALIZE_PROVIDER_ID,
      name: "oauth-finalize",
      // A candidate signup carries the four onboarding fields, and a recruiter signup carries the
      // affiliation form (fullName/mobileNumber/corporateEmail); authorizeOAuthFinalize parses
      // whichever set matches the declared role (shared parseCandidateProfileInput /
      // parseRecruiterVerificationInput) and writes the corresponding data in the finalize
      // transaction. Each signup leaves the other role's fields empty. The HMAC identity carrier
      // is unchanged.
      credentials: {
        carrier: { label: "Carrier", type: "text" },
        role: { label: "Role", type: "text" },
        fullName: { label: "Full name", type: "text" },
        phoneNumber: { label: "Phone number", type: "text" },
        occupation: { label: "Occupation", type: "text" },
        dateOfBirth: { label: "Date of birth", type: "text" },
        mobileNumber: { label: "Mobile number", type: "text" },
        corporateEmail: { label: "Corporate email", type: "text" },
      },
      async authorize(credentials) {
        const finalized = await authorizeOAuthFinalize(credentials).catch((error: unknown) => {
          // Surface a distinct, non-leaking signal for the client; the message propagates via
          // next-auth's credentials error path (same mechanism as the email-password provider).
          const code =
            error instanceof Error && error.message ? error.message : "OAUTH_FINALIZE_FAILED";
          throw new Error(code);
        });

        return {
          id: finalized.id,
          email: finalized.email,
          role: finalized.role,
        };
      },
    }),
    // Google OAuth sign-in. allowDangerousEmailAccountLinking is intentionally TRUE:
    // it is the only way next-auth v4 will link a Google identity into an existing same-email
    // account during a fresh (unauthenticated) sign-in. The danger it names — auto-linking on an
    // unverified email match — is neutralized by the signIn callback's safe-link gate, which lets
    // the link proceed ONLY when both sides are positively email-verified (Google email_verified
    // AND the existing account's own emailVerified) and otherwise fails closed. The gate, not the
    // provider flag, is what makes linking safe (see resolveGoogleSignIn).
    ...(isGoogleAuthConfigured
      ? [
          GoogleProvider({
            clientId: serverEnv.googleClientId as string,
            clientSecret: serverEnv.googleClientSecret as string,
            allowDangerousEmailAccountLinking: true,
            // Force Google's account picker on every sign-in attempt. Without this, Google
            // silently returns the single account currently signed into the browser, which
            // produces a wrong-account sign-in when the operator's intent does not match the
            // browser-cached identity. Pairs with the cross-session takeover guard in
            // resolveGoogleOAuthSignIn (oauth-account.ts): the picker prevents silent
            // identity selection, and the guard prevents silent identity linking to a
            // different active session.
            authorization: { params: { prompt: "select_account" } },
          }),
        ]
      : []),
  ],
  callbacks: {
    // Google sign-in interception. Fires BEFORE the adapter createUser/linkAccount
    // (next-auth@4.24.13, core/routes/callback.js). For the credentials and oauth-finalize
    // providers this is a pass-through (their authorize already gated the sign-in). For Google we
    // delegate to resolveGoogleOAuthSignIn, which returns `true` to proceed (existing-linked or
    // safe-link) or a redirect string that aborts the flow with zero DB writes (suspended →
    // /suspended, fail-closed deny, or brand-new user → role picker carrying the signed identity).
    async signIn({ account, profile, user }) {
      if (account?.provider !== GOOGLE_PROVIDER_ID) {
        return true;
      }

      // `profile` is the raw Google OAuthProfile (sub, email, email_verified, name, picture).
      const googleProfile = (profile ?? {}) as {
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };

      const providerAccountId = account.providerAccountId;
      if (!providerAccountId) {
        return false;
      }

      return resolveGoogleOAuthSignIn({
        providerAccountId,
        email: googleProfile.email ?? (typeof user?.email === "string" ? user.email : null),
        googleEmailVerified: googleProfile.email_verified === true,
        name: googleProfile.name ?? (typeof user?.name === "string" ? user.name : null),
        image: googleProfile.picture ?? null,
      });
    },
    async jwt({ token, user, trigger, session }) {
      if (user) {
        // Authorize() returns the DB row's user-level role. We only write it into the token if
        // it matches the current AppRole set; otherwise we omit it so the session callback
        // surfaces an invalid-role error downstream. This protects against a DB row that still
        // carries a pre-rollback token while AUTH_SECRET rotation has not yet purged JWTs.
        if (typeof user.role === "string" && isAppRole(user.role)) {
          token.role = user.role;
        } else {
          delete token.role;
        }
      } else if (typeof token.role === "string" && !isAppRole(token.role)) {
        // 1.3R-D1 fix — refresh path. On every subsequent request Auth.js v4 re-invokes the jwt
        // callback with `user` undefined and the existing `token` carried forward. A
        // pre-rollback JWT signed with the prior AUTH_SECRET that somehow survived secret
        // rotation (or any token whose role token does not match the current AppRole set) must
        // be cleared here so the session callback never surfaces a stale role. This makes the
        // refresh branch consistent with the sign-in branch above; `normalizeSessionRole`
        // remains the final fail-clean gate, but no longer the only one.
        delete token.role;
      }

      // Populate verifiedRoles. Read DB on sign-in (user present), on
      // explicit session update (trigger==="update"), and once for any legacy JWT that does
      // not yet carry the field. Steady-state requests reuse the cached array without a DB hit.
      const userIdForLoad = typeof user?.id === "string" ? user.id : token.sub;
      const needsVerifiedRolesLoad =
        Boolean(user) || trigger === "update" || !Array.isArray(token.verifiedRoles);
      if (needsVerifiedRolesLoad && typeof userIdForLoad === "string") {
        token.verifiedRoles = await loadVerifiedRoles(userIdForLoad);
      }

      // Refresh on activity. `trigger === "update"` fires when the session
      // is read or updated; we stamp the token to ensure next-auth rewrites the cookie with the
      // sliding expiry. The token's `iat` / `exp` are managed by next-auth based on maxAge.
      if (trigger === "update") {
        token.lastActiveAt = Math.floor(Date.now() / 1000);

        // Second-role prompt dismissal. Caller passes
        // `update({ secondRolePromptDismissed: true })` from "Skip for now". The flag is
        // session-scoped: it lives on the JWT and clears naturally on next sign-in because a
        // fresh JWT is minted. We accept only a boolean and only the dismissal-true case; no
        // other client-controlled token fields can be written through update().
        if (
          typeof session === "object" &&
          session !== null &&
          "secondRolePromptDismissed" in session &&
          (session as { secondRolePromptDismissed?: unknown }).secondRolePromptDismissed === true
        ) {
          token.secondRolePromptDismissed = true;
        }

        // MFA elevation. The client NEVER asserts an `mfaVerified` boolean — it passes
        // only an opaque grant id, minted server-side by the challenge/enrol-confirm routes AFTER a
        // TOTP or recovery code has already been verified. The ONLY trust decision made here is
        // whether consuming that id (a fail-closed, single-use Redis GETDEL) returns THIS token's
        // own userId. A forged `update({ mfaElevationGrant: "anything" })` with no real grant behind
        // it consumes nothing and elevates nothing — `consumeMfaElevationGrant` returns null for a
        // missing/expired/already-consumed id, and any exception (Redis unavailable) is caught and
        // also elevates nothing, matching the fail-closed posture the rest of this gate depends on.
        const elevationGrant = (session as { mfaElevationGrant?: unknown } | null)
          ?.mfaElevationGrant;
        if (typeof elevationGrant === "string" && elevationGrant.length > 0) {
          try {
            const grantedUserId = await consumeMfaElevationGrant(elevationGrant);
            if (grantedUserId && grantedUserId === token.sub) {
              token.mfaVerifiedAt = Math.floor(Date.now() / 1000);
            }
          } catch (error) {
            logger.warn("auth.mfa.elevation_grant_consume_failed", {
              userId: token.sub,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // Fresh sign-in mints a new JWT — explicitly clear any carried dismissal so a previous
      // login session's "Skip for now" does not silently suppress the prompt on the next login.
      // `mfaVerifiedAt` is cleared for the identical reason: an operational account must re-
      // challenge on every new sign-in, whichever provider was used — a prior session's elevation
      // must never carry into a fresh one.
      if (user) {
        delete token.secondRolePromptDismissed;
        delete token.mfaVerifiedAt;
      }

      return token;
    },
    async session({ session, token }) {
      if (!session.user) {
        return session;
      }

      const tokenRole = typeof token?.role === "string" ? token.role : undefined;
      const userId = token?.sub;

      if (!userId) {
        return session;
      }

      session.user.id = userId;

      // One live read backs both the suspension gate and the role. A non-null suspended_at is
      // surfaced as an ISO string; the access layer (assertAuthenticatedSession) turns it into a
      // 403 account_suspended on the next guarded request. See loadLiveAccountState for the
      // fail-open/fail-closed split.
      const account = await loadLiveAccountState(userId);

      if (account.status === "found" && account.suspendedAt) {
        session.user.suspendedAt = account.suspendedAt.toISOString();
      }

      // Surface the role only if it matches the current AppRole set. access-core
      // .normalizeSessionRole is the second-line gate on every guarded request and rejects
      // invalid/stale/absent roles with AccessError 401. So an account whose row no longer exists,
      // or one whose stored role is not a recognised AppRole, leaves session.user.role undefined
      // here and normalizeSessionRole throws 401 on the next access-control check. A JWT carrying
      // an unrecognised role (e.g. a pre-rollback role="student") no longer decides anything while
      // the database is reachable — the stored role replaces it outright. No silent coercion.
      const effectiveRole = resolveEffectiveRole(account, tokenRole);
      if (effectiveRole && isAppRole(effectiveRole)) {
        session.user.role = effectiveRole;
      }

      session.user.verifiedRoles = sanitizeVerifiedRoles(token?.verifiedRoles);

      // Recomputed on every session resolution from the SAME live read as role and
      // suspension — never cached beyond this request. `effectiveRole` (not the raw token role) is
      // what decides applicability, so an operational role whose live read failed and fell back to
      // "no role at all" (resolveEffectiveRole's fail-closed branch) correctly reads
      // not_applicable here too: normalizeSessionRole already rejects a roleless session before any
      // role gate is reached, so this fold does not need to reproduce that rejection.
      session.user.mfaStatus = resolveMfaStatus({
        role: effectiveRole,
        hasVerifiedFactor: account.status === "found" ? account.hasVerifiedMfaFactor : false,
        mfaInvalidatedAt: account.status === "found" ? account.mfaInvalidatedAt : null,
        tokenMfaVerifiedAtSeconds:
          typeof token?.mfaVerifiedAt === "number" ? token.mfaVerifiedAt : undefined,
      });

      // Surface the session-scoped dismissal flag so server components can decide
      // whether to render the post-login interstitial without an extra DB round-trip.
      if (token?.secondRolePromptDismissed === true) {
        session.secondRolePromptDismissed = true;
      }

      return session;
    },
  },
  logger: {
    error(code, metadata) {
      logger.error("NextAuth error", { code, metadata });
    },
    warn(code) {
      logger.warn("NextAuth warning", { code });
    },
  },

  events: {
    signIn({ user }) {
      logger.info("Auth sign-in completed", {
        userId: user.id,
        role: typeof user.role === "string" && isAppRole(user.role) ? user.role : "invalid",
      });
    },
    signOut({ session }) {
      logger.info("Auth sign-out completed", {
        hasSession: Boolean(session),
      });
    },
  },
};
