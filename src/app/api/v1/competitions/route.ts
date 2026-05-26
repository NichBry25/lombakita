import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  assertRecruiterTier,
  OPPORTUNITY_CREATION_MIN_TIER,
  RecruiterTierError,
} from "@/server/auth/recruiter-tier";
import {
  CompetitionError,
  parseCompetitionCreateInput,
  toCompetitionErrorResponse,
} from "@/server/competitions/competition-core";
import { createCompetitionDraft } from "@/server/competitions/competition-service";
import { listPublicCompetitions } from "@/server/competitions/competition-public-service";

// GET — public listing, no auth required.
// Returns only published competitions. Supports filters: q, category, mode, institutionSlug.
// Sorts: deadline_asc | deadline_desc | created_desc (default).
// Pagination: page (1-indexed, default 1), limit (default 20, max 50).
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const filters = {
      q: url.searchParams.get("q") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      mode: url.searchParams.get("mode") ?? undefined,
      institutionSlug: url.searchParams.get("institutionSlug") ?? undefined,
      sort: url.searchParams.get("sort") ?? undefined,
      page: url.searchParams.has("page")
        ? Number.parseInt(url.searchParams.get("page")!, 10)
        : undefined,
      limit: url.searchParams.has("limit")
        ? Number.parseInt(url.searchParams.get("limit")!, 10)
        : undefined,
    };

    const result = await listPublicCompetitions(filters);
    return NextResponse.json(result);
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}

// POST — create a draft competition. Auth required.
// Step 4.0c (CCR-19 / DEC-0053) — recruiter tier gate: the caller must hold the
// OPPORTUNITY_CREATION_MIN_TIER threshold (currently `minimal`). The tier check runs after
// session resolution and before any DB write. Institution membership is validated downstream
// inside createCompetitionDraft.
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    await assertRecruiterTier(session, OPPORTUNITY_CREATION_MIN_TIER);
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
    if (error instanceof RecruiterTierError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: error.status },
      );
    }
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
