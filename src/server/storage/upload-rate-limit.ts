import { NextResponse } from "next/server";
import { checkFixedWindowLimit } from "@/server/redis/rate-limit";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/storage/upload-rate-limit");

// MANUAL-D57: one shared request budget across every route that mints a presigned upload PUT.
//
// ONE BUDGET, NOT ONE PER ROUTE. Every entry point below hands the caller a URL that writes to this
// platform's R2 bucket, and the cost they impose is the same wherever it is spent; twelve separate
// counters would mean the ceiling is really twelve times what it says, and a caller holding a
// candidate account and a recruiter account could draw two allowances against one bucket. The
// question is "how many upload URLs may this account be handed", and that question has no per-route
// answer.
//
// KEYED BY USER ID. Every entry point runs behind authentication, so a stable non-spoofable
// identity is in hand before the limiter is reached — the same reasoning (and the same advantage
// over IP keying) as MFA_ROUTE_RATE_LIMIT.
//
// FAIL-OPEN, INHERITED AND INTENDED. `checkFixedWindowLimit` allows when REDIS_URL is unset and when
// Redis throws: a Redis outage must not stop every candidate from attaching a resume. That is the
// self-service direction, chosen once in server/redis/rate-limit.ts and not re-decided here. It
// bounds a sweep, it does not enforce a quota.
export const UPLOAD_URL_RATE_LIMIT = {
  limit: 30,
  windowSeconds: 10 * 60,
  keyPrefix: "rl:upload-url:",
} as const;

/**
 * The refusal every upload-URL entry point answers with.
 *
 * Built here rather than reusing `rateLimitedResponse` from the auth surface, which takes only a
 * retry hint and hardcodes "Terlalu banyak percobaan. Coba lagi beberapa saat." — a sentence written
 * for a sign-in attempt and untrue of an upload. Shape, status and `Retry-After` are identical to
 * that helper's; only the message differs.
 */
export const uploadUrlRateLimitedResponse = (retryAfterSeconds: number): NextResponse =>
  NextResponse.json(
    {
      error: {
        code: "rate_limited",
        message: "Terlalu banyak permintaan unggah. Coba lagi dalam beberapa menit.",
      },
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

/**
 * Refuses the request when `userId` has spent the shared upload-URL budget for this window.
 *
 * Returns the refusal to the caller rather than a boolean, so the refusal sits at function scope in
 * every route that uses it: a guard that can only be written inside a conditional cannot be moved
 * below the work it guards, and Rule 32 needs both directions to hold. `null` means allowed.
 */
export const assertUploadUrlAllowed = async (userId: string): Promise<NextResponse | null> => {
  const result = await checkFixedWindowLimit({
    key: `${UPLOAD_URL_RATE_LIMIT.keyPrefix}${userId}`,
    limit: UPLOAD_URL_RATE_LIMIT.limit,
    windowSeconds: UPLOAD_URL_RATE_LIMIT.windowSeconds,
  });

  if (result.allowed) {
    return null;
  }

  return uploadUrlRateLimitedResponse(result.retryAfterSeconds);
};
