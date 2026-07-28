import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { RecruiterTierError } from "@/server/auth/recruiter-tier";
import {
  getVerificationSubmissionDetail,
  reviewVerificationSubmission,
  SubmissionError,
} from "@/server/institution-verification/submission-service";
import { VerificationError } from "@/server/institution-verification/verification-core";

type RouteContext = { params: Promise<{ submissionId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { submissionId } = await context.params;
    const submission = await getVerificationSubmissionDetail(
      submissionId,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json({ submission });
  } catch (error) {
    if (error instanceof SubmissionError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { submissionId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "Request body must be valid JSON" } },
        { status: 400 },
      );
    }

    const raw = body as Record<string, unknown>;
    const decision = raw.decision;
    if (decision !== "approved" && decision !== "rejected") {
      return NextResponse.json(
        {
          error: { code: "invalid_payload", message: "decision must be 'approved' or 'rejected'" },
        },
        { status: 400 },
      );
    }

    const reviewerNotes =
      typeof raw.reviewerNotes === "string" ? raw.reviewerNotes.trim() || null : null;

    const result = await reviewVerificationSubmission(
      submissionId,
      decision,
      reviewerNotes,
      session.user.id,
      session.user.role,
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SubmissionError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    if (error instanceof RecruiterTierError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: error.status },
      );
    }
    // Raised when the approval's status transition is refused — the institution moved (a revocation,
    // another approval) between this reviewer opening the queue and deciding.
    if (error instanceof VerificationError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
