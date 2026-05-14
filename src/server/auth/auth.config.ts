import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import CredentialsProvider from "next-auth/providers/credentials";
import { assertRuntimeEnv, serverEnv } from "@/config/env.server";
import { DEFAULT_APP_ROLE, isAppRole } from "@/lib/access/roles";
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

export const authOptions: NextAuthOptions = {
  adapter: authAdapter,
  session: {
    // SESSION STRATEGY POSTURE — known decision, not an oversight.
    // JWT fallback is active. On NEXTAUTH_SECRET rotation, existing JWT sessions
    // may carry stale role data until they expire. DB-backed sessions revalidate
    // on every request and do not have this risk. If role accuracy on rotation
    // becomes a hard requirement, migrate fully to database session strategy.
    strategy: "jwt",
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
    jwt({ token, user }) {
      if (!user) {
        return token;
      }

      const role = user.role;
      token.role = role && isAppRole(role) ? role : DEFAULT_APP_ROLE;

      return token;
    },
    session({ session, user, token }) {
      if (!session.user) {
        return session;
      }

      const userRole = user?.role;
      const tokenRole = typeof token?.role === "string" ? token.role : undefined;
      const rawRole = userRole ?? tokenRole ?? DEFAULT_APP_ROLE;
      const normalizedRole = isAppRole(rawRole) ? rawRole : DEFAULT_APP_ROLE;

      const userId = user?.id ?? token?.sub;

      if (!userId) {
        return session;
      }

      session.user.id = userId;
      session.user.role = normalizedRole;

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
        role: user.role ?? DEFAULT_APP_ROLE,
      });
    },
    signOut({ session }) {
      logger.info("Auth sign-out completed", {
        hasSession: Boolean(session),
      });
    },
  },
};
