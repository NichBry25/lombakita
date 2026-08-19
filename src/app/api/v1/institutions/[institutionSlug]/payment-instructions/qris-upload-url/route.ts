import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { assertSessionMatchesExpectedUser, toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireOwnerInstitutionBySlug } from "@/server/institution-members/member-service";
import {
  PaymentInstructionsError,
  generateQrisUploadUrl,
} from "@/server/institutions/payment-instructions-service";

type RouteContext = { params: Promise<{ institutionSlug: string }> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// POST — a short-lived URL for uploading this institution's QRIS image.
//
// The caller sends only a FILE NAME. The object key is derived server-side from the institution
// resolved out of the slug, so there is no request field that can aim the upload at another
// institution's storage.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);

    const { institutionSlug } = await context.params;
    const db = getDb();
    const { institutionId } = await requireOwnerInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const payload = await request.json().catch(() => null);
    const body = isRecord(payload) ? payload : {};
    const fileName = typeof body.fileName === "string" ? body.fileName : "";

    const grant = await generateQrisUploadUrl(institutionId, { fileName });
    return NextResponse.json(grant);
  } catch (error) {
    if (error instanceof PaymentInstructionsError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
