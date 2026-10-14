import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import type { AppRole } from "@/lib/access/roles";
import { ACCOUNT_STATE_UNAVAILABLE_MESSAGE } from "@/lib/observability/account-state-unavailable";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  AccessError,
  assertAuthenticatedSession,
  assertMfaSatisfiedForOperationalSession,
  assertSessionRole,
  type AuthenticatedSession,
} from "@/server/auth/access-core";
import { authOptions } from "@/server/auth/auth.config";

assertServerOnly("server/auth/session");

export const getCurrentSession = async (): Promise<Session | null> => {
  const session = await getServerSession(authOptions);
  if (session?.user?.accountStateUnavailable) {
    throw new AccessError("account_state_unavailable", 503, ACCOUNT_STATE_UNAVAILABLE_MESSAGE);
  }
  return session;
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
