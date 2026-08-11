import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { type AppRole, isAppRole, isSelfServiceRole, sessionHasRole } from "@/lib/access/roles";
import type { MfaStatus } from "@/server/auth/mfa/mfa-status";

export type AuthenticatedSession = Session & {
  user: NonNullable<Session["user"]> & {
    id: string;
    role: AppRole;
    verifiedRoles: AppRole[];
    mfaStatus: MfaStatus;
  };
};

export type AccessContext = {
  actorUserId: string;
  actorRole: AppRole;
};

export class AccessError extends Error {
  constructor(
    public readonly code:
      | "unauthenticated"
      | "forbidden"
      | "session_user_mismatch"
      | "account_suspended"
      | "mfa_enrolment_required"
      | "mfa_challenge_required",
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

// A session role that is missing, empty, or carries a
// legacy/unknown token (e.g. "student", "institution_admin", "institution_staff" from
// older JWTs) is rejected — NOT silently coerced to a default role. AUTH_SECRET rotation
// at deploy invalidates those JWTs at the signature layer; this guard is the second line
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

  // Suspension gate. Runs before any role check and applies uniformly to all roles.
  // The session callback sets `suspendedAt` from a live DB read, so a suspended account is blocked
  // on its next authenticated request (immediate effect). platform_ops accounts cannot be
  // suspended (enforced at the moderation service layer), so this should never fire for them.
  if (session.user.suspendedAt) {
    throw new AccessError("account_suspended", 403, "This account has been suspended");
  }

  const role = normalizeSessionRole(session.user.role);
  const verifiedRoles = Array.isArray(session.user.verifiedRoles)
    ? session.user.verifiedRoles.filter((entry): entry is AppRole => isAppRole(entry as string))
    : [];
  // See the next-auth.d.ts comment on `mfaStatus`: real sessions always carry a computed value from
  // the session callback; this default only ever fires for a hand-constructed test fixture that
  // predates this field, and it preserves that fixture's old (no-MFA-gate) behaviour exactly.
  const mfaStatus: MfaStatus = session.user.mfaStatus ?? "not_applicable";

  return {
    ...session,
    user: {
      ...session.user,
      role,
      verifiedRoles,
      mfaStatus,
    },
  } as AuthenticatedSession;
};

// MFA choke point #1 of 2 (the other is requireRolePage). Scoped to the NEGATION of
// isSelfServiceRole, never to a `platform_ops` literal, so `finance_ops` — and `reviewer_or_judge`
// — are covered by construction rather than by remembering to list every operational role. Runs
// AFTER the role-permission check passes, so a session that fails sessionHasRole gets the existing
// generic 403 rather than leaking MFA state about a role it does not even hold.
const assertMfaSatisfiedForOperationalSession = (session: AuthenticatedSession): void => {
  if (isSelfServiceRole(session.user.role)) {
    return;
  }

  if (session.user.mfaStatus === "enrolment_required") {
    throw new AccessError(
      "mfa_enrolment_required",
      403,
      "This account must enrol a multi-factor authentication method before continuing",
    );
  }

  if (session.user.mfaStatus === "challenge_required") {
    throw new AccessError(
      "mfa_challenge_required",
      403,
      "This session must complete a multi-factor authentication challenge before continuing",
    );
  }
};

export const assertSessionRole = (
  session: AuthenticatedSession,
  allowedRoles: readonly AppRole[],
): AuthenticatedSession => {
  // Capability-based match (DEC-0060): a dual-verified self-service account signed in under one
  // role still satisfies a gate for its other verified role. Operational-role gates remain matched
  // on the single active role. See sessionHasRole.
  const permitted = allowedRoles.some((role) =>
    sessionHasRole(session.user.role, session.user.verifiedRoles, role),
  );
  if (!permitted) {
    throw new AccessError("forbidden", 403, "Insufficient role permissions");
  }

  assertMfaSatisfiedForOperationalSession(session);

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
