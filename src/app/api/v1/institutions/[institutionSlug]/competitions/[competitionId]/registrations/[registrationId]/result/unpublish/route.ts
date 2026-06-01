import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { ResultError, toResultErrorResponse, unpublishResult } from "@/server/participants/result-service";

type RouteContext = {
  params: Promise<{ institutionSlug: string; competitionId: string; registrationId: string }>;
};

// POST — transition result published → draft, nulling published_at.
export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId, registrationId } = await context.params;
    const db = getDb();
    const { institutionId, actorMembershipId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const result = await unpublishResult(institutionId, competitionId, registrationId, actorMembershipId, db);
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ResultError) return toResultErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
