import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import {
  cancelTeamRegistration,
  submitTeamRegistration,
} from "@/server/teams/team-registration-service";

type RouteContext = { params: Promise<{ competitionId: string; teamId: string }> };

// Step 4.4 — POST submits the team for the competition. Captain-only; gates enforced by the
// service. Auth + role=candidate runs before any DB read; non-candidates receive 403.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId, teamId } = await context.params;
    const result = await submitTeamRegistration(session.user.id, competitionId, teamId);
    return NextResponse.json({ registration: result }, { status: 201 });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

// Step 4.4 / 6.5f — DELETE reverts a submitted team back to forming and cancels its registrations.
// Captain-only. F12 policy (allow toggle, cutoff, required reason) enforced in the service. The
// optional JSON body carries the required cancellationReason; structural shape is validated here,
// the required-and-length business rule lives in the service after the captain + status gates.
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId, teamId } = await context.params;

    let cancellationReason: string | null = null;
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new TeamError("team_invalid_payload", "Request body must be valid JSON");
      }
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const raw = (body as { cancellationReason?: unknown }).cancellationReason;
        if (typeof raw === "string") {
          const trimmed = raw.trim();
          cancellationReason = trimmed.length === 0 ? null : trimmed;
        }
      }
    }

    const result = await cancelTeamRegistration(
      session.user.id,
      competitionId,
      teamId,
      cancellationReason,
    );
    return NextResponse.json({ registration: result });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
