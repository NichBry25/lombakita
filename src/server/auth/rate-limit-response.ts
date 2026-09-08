import { NextResponse } from "next/server";
import { UNKNOWN_CLIENT_IP } from "@/server/auth/client-ip";
import { checkFixedWindowLimit, type FixedWindowResult } from "@/server/redis/rate-limit";

type FixedWindowPolicy = {
  limit: number;
  windowSeconds: number;
  keyPrefix: string;
};

const NOT_BOUNDED: FixedWindowResult = { allowed: true, retryAfterSeconds: 0 };

/**
 * The per-IP bound, skipped when the client IP cannot be resolved.
 *
 * An unresolvable IP arrives as one sentinel string for every caller, so keying on it collapses the
 * whole internet into a single bucket: the moment a forwarded header goes missing, the first few
 * requests exhaust the window and the endpoint is closed to everybody. The credentials login path
 * makes the same trade for the same reason, and both routes that call this keep a per-address bound
 * that still applies.
 *
 * Returning a decision rather than a response keeps the refusal at the caller, at function scope,
 * where it can be seen to sit above the work it guards.
 */
export const checkClientIpBound = async (
  clientIp: string,
  policy: FixedWindowPolicy,
): Promise<FixedWindowResult> => {
  if (clientIp === UNKNOWN_CLIENT_IP) {
    return NOT_BOUNDED;
  }

  return checkFixedWindowLimit({
    key: `${policy.keyPrefix}${clientIp}`,
    limit: policy.limit,
    windowSeconds: policy.windowSeconds,
  });
};

/**
 * The one 429 every unauthenticated auth route answers with.
 *
 * IDENTICAL WHATEVER WAS ASKED FOR. These endpoints sit in front of a lookup that would otherwise
 * disclose whether an address has an account, so the refusal must not vary with the address, the
 * account's state, or which of the route's limiters tripped. A message that named the reason would
 * hand back exactly the fact the uniform success response is written to withhold.
 *
 * Shared rather than rebuilt per route: three copies of a response whose whole value is being
 * indistinguishable is three chances for one of them to drift.
 */
export const rateLimitedResponse = (retryAfterSeconds: number): NextResponse =>
  NextResponse.json(
    {
      error: {
        code: "rate_limited",
        message: "Terlalu banyak percobaan. Coba lagi beberapa saat.",
      },
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
