import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import CredentialsProvider from "next-auth/providers/credentials";
import { assertRuntimeEnv, serverEnv } from "@/config/env.server";
import { isAppRole } from "@/lib/access/roles";
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
    jwt({ token, user, trigger }) {
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

      // CCR-15 / DEC-0049 — refresh on activity. `trigger === "update"` fires when the session
      // is read or updated; we stamp the token to ensure next-auth rewrites the cookie with the
      // sliding expiry. The token's `iat` / `exp` are managed by next-auth based on maxAge.
      if (trigger === "update") {
        token.lastActiveAt = Math.floor(Date.now() / 1000);
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
