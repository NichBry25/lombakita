import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireOwnerInstitutionBySlug } from "@/server/institution-members/member-service";
import {
  PaymentInstructionsError,
  loadPaymentInstructionsForInstitution,
  savePaymentInstructions,
} from "@/server/institutions/payment-instructions-service";

type RouteContext = { params: Promise<{ institutionSlug: string }> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalText = (value: unknown): string | null => (typeof value === "string" ? value : null);

const refuse = (error: unknown): Response => {
  if (error instanceof PaymentInstructionsError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return toAccessDeniedResponse(error);
};

// OWNER-ONLY, not owner-or-staff, and this is the one endpoint in the lane where that distinction
// is load-bearing. Staff already rule on whether a transfer ARRIVED; letting them also set WHERE
// transfers are sent would put "redirect the money" and "mark it received" in the same pair of
// hands. The owner is the account holder, so the owner names the account.
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug } = await context.params;
    const db = getDb();
    const { institutionId } = await requireOwnerInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const instructions = await loadPaymentInstructionsForInstitution(institutionId, db);
    return NextResponse.json({ instructions });
  } catch (error) {
    return refuse(error);
  }
}

// PUT rather than PATCH: the row is the institution's CURRENT answer to "where do we send money",
// and the service upserts it whole. A partial update would let a caller clear the bank fields while
// leaving a stale account holder name attached to them.
export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    // Rule 16. A settings form rendered for one owner and submitted after the browser's session
    // flipped to another would otherwise write this account number onto the second owner's
    // institution, which on this endpoint means redirecting somebody else's incoming payments.
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

    const instructions = await savePaymentInstructions(
      institutionId,
      {
        bankName: optionalText(body.bankName),
        accountNumber: optionalText(body.accountNumber),
        accountHolderName: optionalText(body.accountHolderName),
        // Validated against this institution's own prefix inside the service. The key is accepted
        // here because an upload grant issued moments ago produced it; the service is what refuses
        // one that points anywhere else.
        qrisR2Key: optionalText(body.qrisR2Key),
        instructionsNote: optionalText(body.instructionsNote),
      },
      db,
    );

    return NextResponse.json({ instructions });
  } catch (error) {
    return refuse(error);
  }
}
