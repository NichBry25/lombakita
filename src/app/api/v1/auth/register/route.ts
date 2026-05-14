import { NextResponse } from "next/server";
import { CredentialsAuthError, registerUserWithCredentials } from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = await request.json();
    const result = await registerUserWithCredentials(payload);

    return NextResponse.json({
      registration: result,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return toCredentialsAuthErrorResponse(
        new CredentialsAuthError("invalid_payload", 400, "Registration payload must be valid JSON"),
      );
    }

    return toCredentialsAuthErrorResponse(error);
  }
}
