import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  parseRecruiterVerificationInput,
  RecruiterVerificationError,
  toRecruiterVerificationErrorResponse,
} from "@/server/recruiter-verification/recruiter-verification-core";
import {
  getLatestRecruiterVerificationForUser,
  submitRecruiterVerification,
} from "@/server/recruiter-verification/recruiter-verification-service";

// GET — the caller's latest trust-verification submission (any status) plus its documents.
// Powers the recruiter dashboard status panel. Returns { verification: null } when the account
// has never submitted (e.g. an OAuth recruiter signup that has not yet completed the form).
export async function GET(): Promise<Response> {
  try {
    const session = await requireSessionRole(["recruiter"]);
    const verification = await getLatestRecruiterVerificationForUser(session.user.id);
    return NextResponse.json({ verification });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}

// POST — submit (or re-submit after rejection) the recruiter affiliation form. The account stays
// sandboxed (tier `minimal`) until platform ops approve. 409 when an open submission already
// exists or the account is already Trusted.
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireSessionRole(["recruiter"]);
    assertSessionMatchesExpectedUser(request, session);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "Request body must be valid JSON" } },
        { status: 400 },
      );
    }

    const input = parseRecruiterVerificationInput(body);
    const submission = await submitRecruiterVerification(session.user.id, input);
    return NextResponse.json({ submission }, { status: 201 });
  } catch (error) {
    if (error instanceof RecruiterVerificationError) {
      return toRecruiterVerificationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
