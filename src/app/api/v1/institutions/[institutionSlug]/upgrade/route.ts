import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  InstitutionUpgradeError,
  upgradeInstitutionTypeForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import { InstitutionWorkspaceInputError } from "@/server/institution-workspace/institution-core";
import {
  isFullInstitutionType,
  InstitutionTypeTransitionError,
} from "@/server/institution-workspace/institution-type";

type RouteContext = { params: Promise<{ institutionSlug: string }> };

// Owner-initiated, one-directional personal→full institution type upgrade. This is a declaration,
// not a review: it takes effect immediately and leaves the institution unverified. Document
// verification is a separate credibility-only system reached at the same route once the institution
// is full.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    // Rule #16 — the caller upgrades an institution they own; reject if the active session no longer
    // matches the user the form was rendered for.
    const session = await requireSessionRole(["recruiter"]);
    assertSessionMatchesExpectedUser(request, session);

    const { institutionSlug } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "Request body must be valid JSON" } },
        { status: 400 },
      );
    }

    const raw = body as Record<string, unknown>;
    const targetType = raw.targetType;

    // Only the four full subtypes are upgrade targets. `personal` is rejected here rather than
    // deferred to the transition guard so the payload contract is explicit at the boundary.
    if (!isFullInstitutionType(targetType)) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_payload",
            message:
              "targetType must be one of: company, foundation, university, campus_organization",
          },
        },
        { status: 400 },
      );
    }

    const result = await upgradeInstitutionTypeForOwnerBySlug(
      session.user.id,
      institutionSlug,
      targetType,
      raw.displayName,
    );

    return NextResponse.json(
      {
        institutionType: result.institutionType,
        displayName: result.displayName,
        slug: result.slug,
        previousSlug: result.previousSlug,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof InstitutionUpgradeError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    if (error instanceof InstitutionWorkspaceInputError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: error.httpStatus },
      );
    }
    if (error instanceof InstitutionTypeTransitionError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
