import { NextResponse } from "next/server";
import { SELF_SERVICE_ROLES } from "@/lib/access/roles";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiRole } from "@/server/auth/api-guard";
import {
  issueOrganizationEmailCode,
  OrganizationEmailError,
  toOrganizationEmailErrorResponse,
} from "@/server/host-trust/organization-email-service";

export const POST = withApiRole(SELF_SERVICE_ROLES, async (request, session) => {
  assertSessionMatchesExpectedUser(request, session);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const email =
    typeof body === "object" && body !== null ? (body as { email?: unknown }).email : null;
  if (typeof email !== "string") {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "Request body must be valid JSON with { email: string }",
        },
      },
      { status: 400 },
    );
  }

  try {
    const issued = await issueOrganizationEmailCode(session.user.id, email);
    return NextResponse.json({
      organizationEmailCode: { email: issued.email, expiresAt: issued.expiresAt.toISOString() },
    });
  } catch (error) {
    if (error instanceof OrganizationEmailError) {
      return toOrganizationEmailErrorResponse(error);
    }
    throw error;
  }
});
