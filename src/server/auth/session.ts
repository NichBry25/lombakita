import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import type { AppRole } from "@/lib/access/roles";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  assertAuthenticatedSession,
  assertSessionRole,
  type AuthenticatedSession,
} from "@/server/auth/access-core";
import { authOptions } from "@/server/auth/auth.config";

assertServerOnly("server/auth/session");

export const getCurrentSession = (): Promise<Session | null> => {
  return getServerSession(authOptions);
};

export const requireAuthenticatedSession = async (): Promise<AuthenticatedSession> => {
  return assertAuthenticatedSession(await getCurrentSession());
};

export const requireSessionRole = async (
  allowedRoles: readonly AppRole[],
): Promise<AuthenticatedSession> => {
  return assertSessionRole(await requireAuthenticatedSession(), allowedRoles);
};
