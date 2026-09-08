import { NextResponse } from "next/server";

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
