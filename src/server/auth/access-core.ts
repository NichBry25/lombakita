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
    public readonly code: "unauthenticated" | "forbidden" | "session_user_mismatch",
    public readonly status: 401 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

// Cross-session form submission guard.
// When the user has more than one account active in the same browser (different tabs, recently
// signed-in/out, multi-account add-on), a form rendered for Account A can be submitted while the
// active cookie has flipped to Account B. The server-side enforcement that derives `userId` from
// `session.user.id` would then silently mutate Account B's data instead of Account A's.
//
// Defense: every form rendered for a specific user attaches the rendered-for user id to outgoing
// mutation requests via the `X-Expected-User-Id` request header. This helper compares that header
// to the session that the server actually resolved. Mismatch → 409 `session_user_mismatch`,
// caller is told to reload.
//
// Endpoints that target the calling user's OWN data (profile, eligibility, saved competitions,
// individual registration, team registration) should call this immediately after their session
// gate. Endpoints that target a different user's data (admin tooling, member admin) must NOT
// call this — they have their own authorization model and would always 409 here.
export const assertSessionMatchesExpectedUser = (
  request: Request,
  session: AuthenticatedSession,
): void => {
  const expected = request.headers.get("x-expected-user-id");
  // The header is optional for backward compatibility — older clients that don't send it pass
  // through. Once every user-owned form is wired we can flip this to required.
  if (!expected) return;
  if (expected !== session.user.id) {
    throw new AccessError(
      "session_user_mismatch",
      409,
      "Session changed since this page was rendered — reload the page and try again",
    );
  }
};

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
