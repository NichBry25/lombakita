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
  type RecruiterVerificationWithDocuments,
} from "@/server/recruiter-verification/recruiter-verification-service";

// Recruiter-facing view of a trust submission. Deliberately omits internal fields the reviewed
// recruiter has no business seeing: `reviewerUserId` (the platform_ops actor's identity) and
// `emailDomainFlag` (the internal queue-priority signal). Own-data fields (fullName, mobileNumber,
// corporateEmail) and the review outcome (status, rejectionReason, reviewedAt) are kept.
export const toRecruiterVerificationView = (data: RecruiterVerificationWithDocuments) => {
  const { submission, documents } = data;
  return {
    submission: {
      id: submission.id,
      status: submission.status,
      fullName: submission.fullName,
      mobileNumber: submission.mobileNumber,
      corporateEmail: submission.corporateEmail,
      vouchedAt: submission.vouchedAt,
      rejectionReason: submission.rejectionReason,
      submittedAt: submission.submittedAt,
      reviewedAt: submission.reviewedAt,
    },
    documents: documents.map((document) => ({
      id: document.id,
      originalFileName: document.originalFileName,
      createdAt: document.createdAt,
    })),
  };
};

// GET — the caller's latest trust-verification submission (any status) plus its documents.
// Powers the recruiter dashboard status panel. Returns { verification: null } when the account
// has never submitted (e.g. an OAuth recruiter signup that has not yet completed the form).
export async function GET(): Promise<Response> {
  try {
    const session = await requireSessionRole(["recruiter"]);
    const verification = await getLatestRecruiterVerificationForUser(session.user.id);
    return NextResponse.json({
      verification: verification ? toRecruiterVerificationView(verification) : null,
    });
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
