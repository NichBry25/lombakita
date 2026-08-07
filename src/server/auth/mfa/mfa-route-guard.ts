import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isSelfServiceRole } from "@/lib/access/roles";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
  type AuthenticatedSession,
} from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { MfaError } from "@/server/auth/mfa/mfa-core";

assertServerOnly("server/auth/mfa/mfa-route-guard");

export type MfaGuardedHandler = (
  request: NextRequest,
  session: AuthenticatedSession,
) => Promise<Response> | Response;

// Deliberately bypasses BOTH of the two real authorization choke points (`assertSessionRole` via
// `withApiRole`, and `requireRolePage`). The MFA lifecycle's own routes are exactly what an
// operational account sitting in `enrolment_required` / `challenge_required` must be able to reach
// in order to CLEAR that gate — gating them with the gate they exist to satisfy would be a lock
// with its own key sealed inside it, the same reason /auth/verify-role does not run through
// requireRolePage either.
//
// This is authenticated-plus-"must-be-an-operational-account", not a general-purpose
// authorization pattern, and it must NEVER be reused for an ordinary platform-ops resource route —
// every one of those goes through withApiRole exactly like the other 19 (DEC-0113: two choke
// points, never a per-route guard).
export const withMfaRouteAuth = (handler: MfaGuardedHandler) => {
  return async (request: NextRequest): Promise<Response> => {
    try {
      const session = await requireAuthenticatedSession();

      if (isSelfServiceRole(session.user.role)) {
        return NextResponse.json(
          { error: { code: "forbidden", message: "Multi-factor authentication does not apply to this account" } },
          { status: 403 },
        );
      }

      // CLAUDE.md Rule 16, applied once here rather than three times in the routes: every handler
      // behind this wrapper mutates the CALLING account's own MFA state, which is precisely the
      // shape the rule covers, and both forms already send the header through `sessionFetch`. It
      // sits immediately after the role gate, the position the rule specifies. Placing it in the
      // wrapper — the single thing all three routes pass through — is also what stops the fourth
      // MFA route from being the one that forgets.
      assertSessionMatchesExpectedUser(request, session);

      return await handler(request, session);
    } catch (error) {
      if (error instanceof MfaError) {
        // `Retry-After` alongside the body field, matching how the auth rate limiter answers a 429:
        // the header is the standard machine-readable form, and the body field is what the form
        // actually renders. Present on the invalid-code attempt that engaged the lock as well as on
        // every refusal while it holds — the operator has to learn about the lock from the attempt
        // that caused it, not from the next one behaving differently.
        return NextResponse.json(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
            },
          },
          {
            status: error.status,
            headers:
              error.retryAfterSeconds === null
                ? undefined
                : { "retry-after": String(error.retryAfterSeconds) },
          },
        );
      }
      return toAccessDeniedResponse(error);
    }
  };
};

export const parseMfaCodeBody = async (
  request: NextRequest,
): Promise<{ code: string } | { error: NextResponse }> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      error: NextResponse.json(
        { error: { code: "invalid_payload", message: "Request body must be JSON with { code: string }" } },
        { status: 400 },
      ),
    };
  }

  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;

  if (typeof code !== "string" || code.trim().length === 0) {
    return {
      error: NextResponse.json(
        { error: { code: "invalid_payload", message: "Field 'code' is required" } },
        { status: 400 },
      ),
    };
  }

  return { code: code.trim() };
};
