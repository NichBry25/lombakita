import { NextResponse } from "next/server";
import { classifyEmailForLogin, CredentialsAuthError } from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";

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
