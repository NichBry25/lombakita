import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionError,
  isCompetitionStatus,
  parseCompetitionCreateInput,
  toCompetitionErrorResponse,
} from "@/server/competitions/competition-core";
import {
  createCompetitionDraft,
  listCompetitionsForMember,
} from "@/server/competitions/competition-service";

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new CompetitionError(
        "competition_invalid_payload",
        400,
        "Request body must be valid JSON",
      );
    }
    const input = parseCompetitionCreateInput(body);
    const competition = await createCompetitionDraft(session.user.id, input);
    return NextResponse.json({ competition }, { status: 201 });
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const url = new URL(request.url);
    const institutionSlug = url.searchParams.get("institutionSlug");
    if (!institutionSlug) {
      throw new CompetitionError(
        "competition_invalid_payload",
        400,
        "institutionSlug query parameter is required",
        { fields: ["institutionSlug"] },
      );
    }
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
