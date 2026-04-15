import { NextResponse } from "next/server";
import { CredentialsAuthError } from "@/server/auth/credentials-auth";

export const toCredentialsAuthErrorResponse = (error: unknown): NextResponse => {
  if (error instanceof CredentialsAuthError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details ?? {},
        },
      },
      { status: error.status },
    );
  }

  return NextResponse.json(
    {
      error: {
        code: "auth_unexpected_error",
        message: "Unexpected authentication error",
      },
    },
    { status: 500 },
  );
};
