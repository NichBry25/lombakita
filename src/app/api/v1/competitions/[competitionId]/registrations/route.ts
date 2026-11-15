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
import {
  RegistrationPaymentError,
  toRegistrationPaymentErrorResponse,
} from "@/server/registrations/registration-payment-core";
import { createIndividualRegistration } from "@/server/registrations/registration-service";

type RouteContext = { params: Promise<{ competitionId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    // The owner and staff of the competition's institution pass this gate when they hold the
    // candidate role, and createIndividualRegistration refuses them.
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId } = await context.params;
    const registration = await createIndividualRegistration(session.user.id, competitionId);
    return NextResponse.json({ registration }, { status: 201 });
  } catch (error) {
    if (error instanceof RegistrationError) return toRegistrationErrorResponse(error);
    if (error instanceof RegistrationPaymentError) return toRegistrationPaymentErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
