import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { tickByOrganizationDomain } from "@/server/institution-verification/tick-service";
import {
  toVerificationErrorResponse,
  VerificationError,
} from "@/server/institution-verification/verification-core";

type RouteContext = { params: Promise<{ institutionSlug: string }> };

// Path A: the owner's confirmed Email organisasi is on the workspace's website domain. The matched
// domain is for staff only, so the answer carries the status and the path and never the domain.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    // Rule #16 — the owner acts on their own workspace; reject if the active session no longer
    // matches the rendered-for user.
    const session = await requireSessionRole(["recruiter"]);
    assertSessionMatchesExpectedUser(request, session);

    const { institutionSlug } = await context.params;
    const institution = await tickByOrganizationDomain(session.user.id, institutionSlug);

    return NextResponse.json({ institution });
  } catch (error) {
    if (error instanceof VerificationError) {
      return toVerificationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
