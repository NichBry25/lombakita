import { NextResponse } from "next/server";
import { classifyEmailForLogin, CredentialsAuthError } from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";
import { extractClientIp } from "@/server/auth/client-ip";
import { IDENTIFY_RATE_LIMIT } from "@/server/auth/rate-limit-constants";
import { checkFixedWindowLimit } from "@/server/redis/rate-limit";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

// Step 6.5d.1 — method-first credentials entry classification. Given an email, returns whether it
// maps to no account (`none`), an unverified account (`unverified`), or a verified account
// (`verified`). The single `/auth/login` page uses this to branch the credentials path:
// `verified` → attempt password sign-in; `unverified` → verify-notice + resend; `none` → role
// picker (signup). No auth required (this is a pre-sign-in surface). See classifyEmailForLogin for
// the enumeration trade-off note.
export async function POST(request: Request): Promise<Response> {
  // Fixed-window per-IP rate limit BEFORE any classification, so the acknowledged email-enumeration
  // oracle (6.5d.1-D1) cannot be swept at scale. Fail-open (checkFixedWindowLimit): a Redis outage
  // never blocks a legitimate sign-in.
  const clientIp = extractClientIp((name) => request.headers.get(name));
  const rate = await checkFixedWindowLimit({
    key: `${IDENTIFY_RATE_LIMIT.keyPrefix}${clientIp}`,
    limit: IDENTIFY_RATE_LIMIT.limit,
    windowSeconds: IDENTIFY_RATE_LIMIT.windowSeconds,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: {
          code: "rate_limited",
          message: "Terlalu banyak percobaan. Coba lagi beberapa saat.",
        },
      },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  try {
    const raw = await request.json();
    const email = isRecord(raw) ? raw.email : undefined;
    const result = await classifyEmailForLogin(email);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return toCredentialsAuthErrorResponse(
        new CredentialsAuthError("invalid_payload", 400, "Payload must be valid JSON"),
      );
    }
    return toCredentialsAuthErrorResponse(error);
  }
}
