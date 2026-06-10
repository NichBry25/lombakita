import { NextResponse } from "next/server";
import { assertSessionMatchesExpectedUser, toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { RecruiterTierError } from "@/server/auth/recruiter-tier";
import {
  createVerificationSubmission,
  SubmissionError,
  type DocumentInput,
} from "@/server/institution-verification/submission-service";
import { InstitutionTypeTransitionError } from "@/server/institution-workspace/institution-type";
import type { InstitutionType } from "@/server/db/schema";

type RouteContext = { params: Promise<{ institutionSlug: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    // Rule #16 — the caller submits on behalf of an institution they own; reject if the active
    // session no longer matches the rendered-for user.
    const session = await requireSessionRole(["recruiter"]);
    assertSessionMatchesExpectedUser(request, session);

    const { institutionSlug } = await context.params;

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
    const targetType = raw.targetType;
    const proposedDisplayName =
      typeof raw.proposedDisplayName === "string" ? raw.proposedDisplayName : null;

    if (typeof targetType !== "string") {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "targetType is required" } },
        { status: 400 },
      );
    }

    const rawDocs = raw.documents;
    if (!Array.isArray(rawDocs) || rawDocs.length === 0) {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "documents array is required" } },
        { status: 400 },
      );
    }

    const documents: DocumentInput[] = rawDocs.map((d: unknown) => {
      const doc = d as Record<string, unknown>;
      return {
        documentType: String(doc.documentType ?? ""),
        originalFileName: String(doc.originalFileName ?? ""),
        fileSizeBytes: Number(doc.fileSizeBytes ?? 0),
        contentType: String(doc.contentType ?? ""),
      };
    });

    const result = await createVerificationSubmission(
      institutionSlug,
      targetType as InstitutionType,
      proposedDisplayName,
      documents,
      session.user.id,
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof SubmissionError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: error.status },
      );
    }
    if (error instanceof RecruiterTierError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: error.status },
      );
    }
    if (error instanceof InstitutionTypeTransitionError) {
      return NextResponse.json(
        { error: { code: "institution_type_transition_invalid", message: error.message } },
        { status: 422 },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
