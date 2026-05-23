import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { type AppRole, isAppRole } from "@/lib/access/roles";

export type AuthenticatedSession = Session & {
  user: NonNullable<Session["user"]> & {
    id: string;
    role: AppRole;
    verifiedRoles: AppRole[];
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

// Rollback Step 1.3 (CCR-01 / DEC-0035): a session role that is missing, empty, or carries a
// legacy/unknown token (e.g. "student", "institution_admin", "institution_staff" from
// pre-rollback JWTs) is rejected — NOT silently coerced to a default role. AUTH_SECRET rotation
// at deploy invalidates pre-rollback JWTs at the signature layer; this guard is the second line
// of defense for any token that somehow passes signature validation but does not match the new
// user-level role set.
export const normalizeSessionRole = (value: string | undefined | null): AppRole => {
  if (typeof value === "string" && isAppRole(value)) {
    return value;
  }

  throw new AccessError("unauthenticated", 401, "Session role is invalid or stale");
};

export const assertAuthenticatedSession = (session: Session | null): AuthenticatedSession => {
  if (!session?.user || !session.user.id) {
    throw new AccessError("unauthenticated", 401, "Authentication required");
  }

  const role = normalizeSessionRole(session.user.role);
  const verifiedRoles = Array.isArray(session.user.verifiedRoles)
    ? session.user.verifiedRoles.filter((entry): entry is AppRole => isAppRole(entry as string))
    : [];

  return {
    ...session,
    user: {
      ...session.user,
      role,
      verifiedRoles,
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
