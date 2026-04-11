import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import EmailProvider from "next-auth/providers/email";
import { publicEnv } from "@/config/env";
import { assertRuntimeEnv, serverEnv } from "@/config/env.server";
import { DEFAULT_APP_ROLE, isAppRole } from "@/lib/access/roles";
import { logger } from "@/lib/logger";
import { getDb } from "@/server/db/client";
import { accounts, sessions, users, verificationTokens } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/auth.config");

assertRuntimeEnv("web");

export const isEmailAuthConfigured = Boolean(serverEnv.resendApiKey && serverEnv.authEmailFrom);

export const isAuthPersistenceConfigured = Boolean(serverEnv.databaseUrl);

const fallbackEmailFrom = "auth@localhost.invalid";

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
    strategy: authAdapter ? "database" : "jwt",
  },
  secret: serverEnv.authSecret,
  pages: {
    signIn: "/auth/sign-in",
    verifyRequest: "/auth/verify-request",
  },
  providers: [
    EmailProvider({
      from: serverEnv.authEmailFrom ?? fallbackEmailFrom,
      server: {
        host: "smtp.resend.com",
        port: 587,
        auth: {
          user: "resend",
          pass: serverEnv.resendApiKey ?? "missing-resend-api-key",
        },
      },
      maxAge: 15 * 60,
    }),
  ],
  callbacks: {
    session({ session, user, token }) {
      if (!session.user) {
        return session;
      }

      const rawRole =
        (user as { role?: string } | undefined)?.role ??
        (token as { role?: string } | undefined)?.role ??
        DEFAULT_APP_ROLE;
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
  events: {
    signIn({ user }) {
      logger.info("Auth sign-in completed", {
        userId: user.id,
        role: (user as { role?: string }).role ?? DEFAULT_APP_ROLE,
      });
    },
    signOut({ session }) {
      logger.info("Auth sign-out completed", {
        hasSession: Boolean(session),
      });
    },
  },
};

export const authScaffoldConfig = {
  baseUrl: serverEnv.authUrl ?? publicEnv.appUrl,
  secretConfigured: Boolean(serverEnv.authSecret),
  providerMode: "resend_magic_link",
  providerConfigured: isEmailAuthConfigured,
  persistenceConfigured: isAuthPersistenceConfigured,
} as const;
