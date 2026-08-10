import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isSelfServiceRole } from "@/lib/access/roles";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
  type AuthenticatedSession,
} from "@/server/auth/access-core";
import { logger } from "@/lib/logger";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { MFA_ROUTE_RATE_LIMIT } from "@/server/auth/rate-limit-constants";
import { checkFixedWindowLimitFailClosed } from "@/server/redis/rate-limit";
import { MfaError } from "@/server/auth/mfa/mfa-core";

assertServerOnly("server/auth/mfa/mfa-route-guard");

/**
 * The per-account request ceiling, applied FAIL-CLOSED, before the handler runs.
 *
 * ORDER IS THE POINT. Every one of the three handlers opens a transaction that takes `FOR UPDATE`
 * on the account's factor row and, on a wrong code, spends one of the five database-backed attempts
 * that are the actual security bound. A limiter placed after the handler — or inside it — would let
 * a throttled request burn that budget on the way to being refused, which hands an attacker a way
 * to lock a legitimate operator out by flooding the endpoint. Refusing here means a throttled
 * request touches no factor row, spends no attempt, and takes no lock.
 *
 * FAIL-CLOSED, which is why the DEC-0098 limiter could not simply be reused
 * here: that one fails OPEN, so a Redis outage would silently remove this ceiling at exactly the
 * moment an attacker would most want it gone. Refusing operational access when Redis is unreachable
 * is already this system's shipped position — `issueMfaElevationGrant` and `consumeStoredGrant` both
 * refuse on the same condition, so an operator with no Redis could not complete a challenge anyway.
 * This moves that refusal earlier and gives it an honest error code instead of a 503 from the
 * elevation step after the code was already spent.
 */
const assertUnderMfaRequestLimit = async (userId: string): Promise<void> => {
  const outcome = await checkFixedWindowLimitFailClosed({
    key: `${MFA_ROUTE_RATE_LIMIT.keyPrefix}${userId}`,
    limit: MFA_ROUTE_RATE_LIMIT.limit,
    windowSeconds: MFA_ROUTE_RATE_LIMIT.windowSeconds,
  });

  // Exhaustive switch rather than a chain of positive `if`s, because the difference is the DEFAULT.
  // Falling off the end of two `if`s ALLOWS, so widening `FixedWindowDecision` with a fourth variant
  // would let MFA requests through unthrottled with nothing failing — inside the one function whose
  // entire purpose is refusing when it cannot confirm. Typed `never` in the default arm, a new
  // variant is a compile error instead (matching `throwForOutcome` in factor-service.ts).
  switch (outcome.decision) {
    case "allowed":
      return;

    case "throttled": {
      // A throttled request writes NO audit row — it is refused before any handler runs and mutates
      // nothing, and `platform_ops_audit_logs` records platform_ops ACTIONS (Rule 7), not requests
      // that were turned away. Letting refusals write there would make the audit table growable by
      // request volume, which is the one table an attacker should least be able to inflate.
      //
      // But the abuse still has to be VISIBLE, or a step whose whole purpose is abuse resistance
      // ships with the abuse invisible. A structured log line is the right carrier: it lands in the
      // same stream as every other server event, costs no table growth, and names the account so a
      // sustained attempt against one operator can actually be seen.
      logger.warn("auth.mfa.rate_limited", {
        userId,
        retryAfterSeconds: outcome.retryAfterSeconds,
        limit: MFA_ROUTE_RATE_LIMIT.limit,
        windowSeconds: MFA_ROUTE_RATE_LIMIT.windowSeconds,
      });

      throw new MfaError(
        "mfa_rate_limited",
        429,
        "Too many verification requests — wait a moment and try again",
        outcome.retryAfterSeconds,
      );
    }

    case "unavailable": {
      // The Redis degradation itself is already reported to Sentry by the primitive
      // (reportRedisDegradation). This line records the CONSEQUENCE — that an operator was refused —
      // which the primitive cannot know about.
      logger.warn("auth.mfa.rate_limiter_unavailable", { userId });

      throw new MfaError(
        "mfa_rate_limit_unavailable",
        503,
        "Verification is temporarily unavailable",
      );
    }

    default: {
      const unhandled: never = outcome;
      throw new MfaError(
        "mfa_rate_limit_unavailable",
        503,
        `Verification is temporarily unavailable (unhandled limiter decision ${JSON.stringify(unhandled)})`,
      );
    }
  }
};

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
          {
            error: {
              code: "forbidden",
              message: "Multi-factor authentication does not apply to this account",
            },
          },
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

      // After the identity checks (so the key is a resolved session's user id, not a claim) and
      // before the handler (so a throttled request spends none of the database attempt budget).
      await assertUnderMfaRequestLimit(session.user.id);

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
              ...(error.retryAfterSeconds === null
                ? {}
                : { retryAfterSeconds: error.retryAfterSeconds }),
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
        {
          error: {
            code: "invalid_payload",
            message: "Request body must be JSON with { code: string }",
          },
        },
        { status: 400 },
      ),
    };
  }

  const code =
    typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;

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
