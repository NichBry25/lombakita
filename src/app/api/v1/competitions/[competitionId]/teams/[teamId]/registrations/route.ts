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

// Step 4.4 — DELETE reverts a submitted team back to forming. Captain-only.
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId, teamId } = await context.params;
    const result = await cancelTeamRegistration(session.user.id, competitionId, teamId);
    return NextResponse.json({ registration: result });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
