import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  parseCancelPayload,
  RegistrationError,
  toRegistrationErrorResponse,
} from "@/server/registrations/registration-core";
import { cancelRegistration } from "@/server/registrations/registration-service";

type RouteContext = {
  params: Promise<{ competitionId: string; registrationId: string }>;
};

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    const { competitionId, registrationId } = await context.params;

    // Body is optional. If supplied as empty/non-JSON, treat as no body — don't fail the
    // cancel because of a stray Content-Type header.
    let payload: unknown = null;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        payload = await request.json();
      } catch {
        throw new RegistrationError(
          "registration_invalid_payload",
          "Request body must be valid JSON",
        );
      }
    }

    const { cancellationReason } = parseCancelPayload(payload);

    const registration = await cancelRegistration(
      session.user.id,
      competitionId,
      registrationId,
      cancellationReason,
    );

    return NextResponse.json({ registration });
  } catch (error) {
    if (error instanceof RegistrationError) return toRegistrationErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
