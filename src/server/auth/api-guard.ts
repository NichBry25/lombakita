import type { NextRequest } from "next/server";
import type { AppRole } from "@/lib/access/roles";
import { toAccessDeniedResponse, type AuthenticatedSession } from "@/server/auth/access-core";
import { requireAuthenticatedSession, requireSessionRole } from "@/server/auth/session";

export type GuardedApiHandler = (
  request: NextRequest,
  session: AuthenticatedSession,
) => Promise<Response> | Response;

export const withApiAuth = (handler: GuardedApiHandler) => {
  return async (request: NextRequest): Promise<Response> => {
    try {
      const session = await requireAuthenticatedSession();
      return await handler(request, session);
    } catch (error) {
      return toAccessDeniedResponse(error);
    }
  };
};

export const withApiRole = (allowedRoles: readonly AppRole[], handler: GuardedApiHandler) => {
  return async (request: NextRequest): Promise<Response> => {
    try {
      const session = await requireSessionRole(allowedRoles);
      return await handler(request, session);
    } catch (error) {
      return toAccessDeniedResponse(error);
    }
  };
};
