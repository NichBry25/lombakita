import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { listCompetitionParticipants } from "@/server/participants/participant-service";

export async function GET(
  request: Request,
  context: { params: Promise<{ institutionSlug: string; competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId } = await context.params;
    const slug = institutionSlug.trim().toLowerCase();

    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(session.user.id, slug, db);

    const url = new URL(request.url);
    const rawStatus = url.searchParams.get("status") ?? "all";
    const rawType = url.searchParams.get("type") ?? "all";
    const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
    const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);

    const validStatuses = ["all", "confirmed", "cancelled"] as const;
    const validTypes = ["all", "individual", "team"] as const;
    type StatusFilter = (typeof validStatuses)[number];
    type TypeFilter = (typeof validTypes)[number];

    const status: StatusFilter = (validStatuses as readonly string[]).includes(rawStatus)
      ? (rawStatus as StatusFilter)
      : "all";
    const type: TypeFilter = (validTypes as readonly string[]).includes(rawType)
      ? (rawType as TypeFilter)
      : "all";

    // Clamp limit to max 50 server-side.
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

    const result = await listCompetitionParticipants(
      institutionId,
      competitionId,
      { status, type, page, limit },
      db,
    );

    return NextResponse.json(result);
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
