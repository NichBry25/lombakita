import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import type { AppRole } from "@/lib/access/roles";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  assertAuthenticatedSession,
  assertMfaSatisfiedForOperationalSession,
  assertSessionRole,
  type AuthenticatedSession,
} from "@/server/auth/access-core";
import { authOptions } from "@/server/auth/auth.config";

assertServerOnly("server/auth/session");

export const getCurrentSession = (): Promise<Session | null> => {
  return getServerSession(authOptions);
};

export const requireAuthenticatedSession = async (options?: {
  allowUnsatisfiedMfa?: boolean;
}): Promise<AuthenticatedSession> => {
  const session = assertAuthenticatedSession(await getCurrentSession());
  if (!options?.allowUnsatisfiedMfa) {
    assertMfaSatisfiedForOperationalSession(session);
  }
  return session;
};

export const requireSessionRole = async (
  allowedRoles: readonly AppRole[],
): Promise<AuthenticatedSession> => {
  return assertSessionRole(
    await requireAuthenticatedSession({ allowUnsatisfiedMfa: true }),
    allowedRoles,
  );
};
