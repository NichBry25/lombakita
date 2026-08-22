import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import {
  ManualProofError,
  generateManualProofViewUrl,
} from "@/server/finance/manual-payment-proof-service";

type RouteContext = {
  params: Promise<{ institutionSlug: string; competitionId: string; proofId: string }>;
};

// POST mints a short-lived URL for the reviewing organiser to look at one bukti transfer.
//
// POST rather than GET, deliberately. This is not a read: it writes an audit row recording that
// this organiser looked at this candidate's receipt. A GET that mutates is a GET a browser, a
// prefetcher or a link preview will fire on its own, and every one of those would forge an access
// record for a human who never opened it.
//
// The institution comes from the slug and is handed to the service, which scopes the proof lookup
// in the same query. A proof from another organiser's competition resolves to nothing, so no URL is
// minted and no audit row is written for an access that did not happen.
export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, proofId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const grant = await generateManualProofViewUrl(institutionId, session.user.id, proofId, db);
    return NextResponse.json(grant);
  } catch (error) {
    if (error instanceof ManualProofError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
