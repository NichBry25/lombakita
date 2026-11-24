import { NextResponse } from "next/server";
import { SELF_SERVICE_ROLES } from "@/lib/access/roles";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiRole } from "@/server/auth/api-guard";
import {
  confirmOrganizationEmailCode,
  OrganizationEmailError,
  toOrganizationEmailErrorResponse,
} from "@/server/host-trust/organization-email-service";

const SIX_DIGITS = /^[0-9]{6}$/;

export const POST = withApiRole(SELF_SERVICE_ROLES, async (request, session) => {
  assertSessionMatchesExpectedUser(request, session);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const rawCode =
    typeof body === "object" && body !== null ? (body as { code?: unknown }).code : null;
  const code = typeof rawCode === "string" ? rawCode.trim() : null;
  if (code === null || !SIX_DIGITS.test(code)) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "Request body must be valid JSON with { code: string of 6 digits }",
        },
      },
      { status: 400 },
    );
  }

  try {
    const confirmed = await confirmOrganizationEmailCode(session.user.id, code);
    return NextResponse.json({
      organizationEmail: { email: confirmed.email, trustSource: confirmed.trustSource },
    });
  } catch (error) {
    if (error instanceof OrganizationEmailError) {
      return toOrganizationEmailErrorResponse(error);
    }
    throw error;
  }
});
