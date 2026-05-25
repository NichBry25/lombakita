import { NextResponse } from "next/server";
import { withApiAuth } from "@/server/auth/api-guard";
import {
  dashboardPathForRole,
  isVerifiableRole,
  markRoleAsVerifiedStub,
  RoleVerificationError,
} from "@/server/auth/role-verification";

// STUB: CCR-19 — verification mechanics deferred. POST flips the per-role verified-at
// timestamp directly. The real verification flow (intake form, document upload, ops review
// queue, email notifications) lands in a later phase.
//
// Note on path: the step prompt describes this as `POST /api/auth/verify-role`. The project's
// established API surface lives under `/api/v1/auth/...` (see /api/v1/auth/register,
// /api/v1/auth/session) and the bare `/api/auth/...` namespace is owned by next-auth's
// `[...nextauth]` catch-all. Mounting here keeps namespace ownership clean and matches the
// existing convention.
export const POST = withApiAuth(async (request, session) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "Request body must be valid JSON with { role: 'candidate' | 'recruiter' }",
        },
      },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "Request body must be an object with a 'role' field",
        },
      },
      { status: 400 },
    );
  }

  const role = (body as { role?: unknown }).role;
  if (!isVerifiableRole(role)) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_role",
          message: "Field 'role' must be 'candidate' or 'recruiter'",
        },
      },
      { status: 400 },
    );
  }

  try {
    await markRoleAsVerifiedStub(session.user.id, role);
  } catch (error) {
    if (error instanceof RoleVerificationError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    throw error;
  }

  return NextResponse.json({
    verified: role,
    redirectTo: dashboardPathForRole(role),
  });
});
