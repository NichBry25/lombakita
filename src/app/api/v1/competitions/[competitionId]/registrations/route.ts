import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  RegistrationError,
  toRegistrationErrorResponse,
} from "@/server/registrations/registration-core";
import { createIndividualRegistration } from "@/server/registrations/registration-service";

type RouteContext = { params: Promise<{ competitionId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    // Auth + role=candidate gate before any DB access. institution_owner, institution_staff,
    // platform_ops, finance_ops all receive 403 here.
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId } = await context.params;
    const registration = await createIndividualRegistration(session.user.id, competitionId);
    return NextResponse.json({ registration }, { status: 201 });
  } catch (error) {
    if (error instanceof RegistrationError) return toRegistrationErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
