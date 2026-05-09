import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionError,
  isCompetitionStatus,
  toCompetitionErrorResponse,
} from "@/server/competitions/competition-core";
import { listCompetitionsForMember } from "@/server/competitions/competition-service";

// GET — institution-member listing (all statuses: draft, published, archived).
// Auth required. Actor must be an active member of the institution.
// Used by the institution competition management UI.
export async function GET(
  request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug } = await context.params;
    const url = new URL(request.url);
    const statusRaw = url.searchParams.get("status");
    const status = statusRaw && isCompetitionStatus(statusRaw) ? statusRaw : undefined;
    const pageRaw = url.searchParams.get("page");
    const page = pageRaw ? Number.parseInt(pageRaw, 10) : undefined;

    const result = await listCompetitionsForMember(session.user.id, {
      institutionSlug: institutionSlug.trim().toLowerCase(),
      status,
      page: Number.isFinite(page) ? page : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
