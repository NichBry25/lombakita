import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import {
  ResultError,
  toResultErrorResponse,
  parseResultDraftInput,
  getResultForInstitution,
  upsertResultDraft,
} from "@/server/participants/result-service";

type RouteContext = {
  params: Promise<{ institutionSlug: string; competitionId: string; registrationId: string }>;
};

// Institution-internal result tooling. Acting on another user's registration —
// per CLAUDE.md Rule #16 the cross-session session-match guard is intentionally NOT applied.

// GET — fetch current result state including registration context for the result sub-page.
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId, registrationId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const result = await getResultForInstitution(institutionId, competitionId, registrationId, db);
    if (!result) {
      return NextResponse.json(
        { error: { code: "result_registration_not_found", message: "Registration not found" } },
        { status: 404 },
      );
    }

    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ResultError) return toResultErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

// PUT — create or update a draft result. Rejected if already published.
export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId, registrationId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const body = await request.json().catch(() => null);
    const input = parseResultDraftInput(body);

    const result = await upsertResultDraft(institutionId, competitionId, registrationId, input, db);
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ResultError) return toResultErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
