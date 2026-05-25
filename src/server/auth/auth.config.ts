import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import type { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import CredentialsProvider from "next-auth/providers/credentials";
import { assertRuntimeEnv, serverEnv } from "@/config/env.server";
import { type AppRole, isAppRole } from "@/lib/access/roles";
import { logger } from "@/lib/logger";
import { authenticateWithEmailPassword } from "@/server/auth/credentials-auth";
import { getDb } from "@/server/db/client";
import { accounts, sessions, users, verificationTokens } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/auth.config");

assertRuntimeEnv("web");

export const isEmailAuthConfigured = Boolean(serverEnv.resendApiKey && serverEnv.authEmailFrom);

export const isAuthPersistenceConfigured = Boolean(serverEnv.databaseUrl);

const authAdapter: Adapter | undefined = isAuthPersistenceConfigured
  ? (DrizzleAdapter(getDb(), {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }) as Adapter)
  : undefined;

// Rollback Step 1.3 / CCR-15 / DEC-0049 — persistent session cookie behaviour.
// Target lifetime is one year. Refresh-on-activity advances the cookie's effective expiry every
// time the session callback fires (each request that resolves the session). Session strategy
// remains "jwt" per DEC-0015 (explicitly preserved). Termination on explicit logout, password
// change, or server-initiated invalidation is provided by next-auth + AUTH_SECRET rotation.
export const PERSISTENT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

// CCR-02 / CCR-04 — per-mode verification state, surfaced as the verifiedRoles array on the
// session. A role is in verifiedRoles iff its corresponding *_verified_at timestamp on the user
// row is non-null (the Step 1.3 schema: users.candidateVerifiedAt, users.recruiterVerifiedAt;
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
    signIn: "/auth/sign-in",
  },
  providers: [
    CredentialsProvider({
      name: "email-password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const emailInput = credentials?.email;
        const passwordInput = credentials?.password;

        if (typeof emailInput !== "string" || typeof passwordInput !== "string") {
          throw new Error("INVALID_CREDENTIALS");
        }

        const result = await authenticateWithEmailPassword(emailInput, passwordInput).catch(() => {
          throw new Error("INVALID_CREDENTIALS");
        });

        if (result.status === "email_not_verified") {
          throw new Error("EMAIL_NOT_VERIFIED");
        }

        if (result.status === "invalid_credentials") {
          throw new Error("INVALID_CREDENTIALS");
        }

        return {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role,
        };
      },
    }),
  ],
  callbacks: {
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

      // CCR-02 / CCR-04 — populate verifiedRoles. Read DB on sign-in (user present), on
      // explicit session update (trigger==="update"), and once for any legacy JWT that does
      // not yet carry the field. Steady-state requests reuse the cached array without a DB hit.
      const userIdForLoad = typeof user?.id === "string" ? user.id : token.sub;
      const needsVerifiedRolesLoad =
        Boolean(user) || trigger === "update" || !Array.isArray(token.verifiedRoles);
      if (needsVerifiedRolesLoad && typeof userIdForLoad === "string") {
        token.verifiedRoles = await loadVerifiedRoles(userIdForLoad);
      }

      // CCR-15 / DEC-0049 — refresh on activity. `trigger === "update"` fires when the session
      // is read or updated; we stamp the token to ensure next-auth rewrites the cookie with the
      // sliding expiry. The token's `iat` / `exp` are managed by next-auth based on maxAge.
      if (trigger === "update") {
        token.lastActiveAt = Math.floor(Date.now() / 1000);

        // Step 4.0b — second-role prompt dismissal. Caller passes
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
      }

      // Fresh sign-in mints a new JWT — explicitly clear any carried dismissal so a previous
      // login session's "Skip for now" does not silently suppress the prompt on the next login.
      if (user) {
        delete token.secondRolePromptDismissed;
      }

      return token;
    },
    session({ session, token }) {
      if (!session.user) {
        return session;
      }

      const tokenRole = typeof token?.role === "string" ? token.role : undefined;
      const userId = token?.sub;

      if (!userId) {
        return session;
      }

      session.user.id = userId;
      // Surface the token's role only if it still matches the current AppRole set.
      // access-core.normalizeSessionRole is the second-line gate on every guarded request and
      // rejects invalid/stale role tokens with AccessError 401. Together this means: a stale
      // JWT carrying role="student" produces session.user.role = undefined here, then
      // normalizeSessionRole throws 401 on the next access-control check. No silent coercion.
      if (tokenRole && isAppRole(tokenRole)) {
        session.user.role = tokenRole;
      }

      session.user.verifiedRoles = sanitizeVerifiedRoles(token?.verifiedRoles);

      // Step 4.0b — surface the session-scoped dismissal flag so server components can decide
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
