import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { DEFAULT_APP_ROLE, type AppRole, isAppRole } from "@/lib/access/roles";

export type AuthenticatedSession = Session & {
  user: NonNullable<Session["user"]> & {
    id: string;
    role: AppRole;
  };
};

export type AccessContext = {
  actorUserId: string;
  actorRole: AppRole;
};

export class AccessError extends Error {
  constructor(
    public readonly code: "unauthenticated" | "forbidden",
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

const normalizeSessionRole = (value: string | undefined): AppRole => {
  if (value && isAppRole(value)) {
    return value;
  }

  return DEFAULT_APP_ROLE;
};

export const assertAuthenticatedSession = (session: Session | null): AuthenticatedSession => {
  if (!session?.user || !session.user.id) {
    throw new AccessError("unauthenticated", 401, "Authentication required");
  }

  const role = normalizeSessionRole(session.user.role);

  return {
    ...session,
    user: {
      ...session.user,
      role,
    },
  } as AuthenticatedSession;
};

export const assertSessionRole = (
  session: AuthenticatedSession,
  allowedRoles: readonly AppRole[],
): AuthenticatedSession => {
  if (!allowedRoles.includes(session.user.role)) {
    throw new AccessError("forbidden", 403, "Insufficient role permissions");
  }

  return session;
};

export const buildAccessContext = (session: AuthenticatedSession): AccessContext => {
  return {
    actorUserId: session.user.id,
    actorRole: session.user.role,
  };
};

export const toAccessDeniedResponse = (error: unknown): NextResponse => {
  if (error instanceof AccessError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
        },
      },
      { status: error.status },
    );
  }

  return NextResponse.json(
    {
      error: {
        code: "access_guard_failed",
        message: "Unexpected access-guard failure",
      },
    },
    { status: 500 },
  );
};
