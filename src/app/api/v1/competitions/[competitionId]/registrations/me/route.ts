import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  RegistrationError,
  toRegistrationErrorResponse,
} from "@/server/registrations/registration-core";
import { getStudentRegistration } from "@/server/registrations/registration-service";

type RouteContext = { params: Promise<{ competitionId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    const { competitionId } = await context.params;
    const registration = await getStudentRegistration(session.user.id, competitionId);

    if (!registration) {
      return NextResponse.json(
        { error: { code: "registration_not_found", message: "No registration found" } },
        { status: 404 },
      );
    }

    return NextResponse.json({ registration });
  } catch (error) {
    if (error instanceof RegistrationError) return toRegistrationErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
