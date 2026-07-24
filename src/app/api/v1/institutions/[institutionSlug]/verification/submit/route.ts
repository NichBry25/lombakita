import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  createVerificationSubmission,
  SubmissionError,
  type DocumentInput,
} from "@/server/institution-verification/submission-service";

type RouteContext = { params: Promise<{ institutionSlug: string }> };

// Document verification for a full institution. The institution's type is fixed at creation, so the
// required documents are derived server-side from that type — the client submits documents only,
// never a type.
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

    const result = await createVerificationSubmission(institutionSlug, documents, session.user.id);

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof SubmissionError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
