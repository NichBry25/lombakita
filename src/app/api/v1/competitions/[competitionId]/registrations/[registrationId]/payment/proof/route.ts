import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { loadCandidatePaymentView } from "@/server/finance/candidate-payment-view";
import {
  ManualProofError,
  reopenManualPaymentProof,
  submitManualPaymentProof,
} from "@/server/finance/manual-payment-proof-service";

type RouteContext = {
  params: Promise<{ competitionId: string; registrationId: string }>;
};

type ProofBody = {
  r2Key: string;
  originalFileName: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readProofBody = async (request: Request): Promise<ProofBody> => {
  let payload: unknown = {};
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      payload = await request.json();
    } catch {
      throw new ManualProofError(
        "manual_proof_object_key_invalid",
        "Isi permintaan harus berupa JSON yang valid",
        400,
      );
    }
  }

  const body = isRecord(payload) ? payload : {};
  const r2Key = typeof body.r2Key === "string" ? body.r2Key : "";
  const originalFileName = typeof body.originalFileName === "string" ? body.originalFileName : "";

  // ONLY THESE TWO ARE READ. The size and the content type used to be taken from the request too,
  // and both are now read back from storage instead. A declared size bounded nothing, and a
  // declared content type was handed to R2 as the response type on an inline view, which let a
  // payer choose what the reviewer's browser would render. The request spreads into the service
  // input, so a field parsed here is a field accepted; the way not to accept them is not to parse
  // them.
  if (originalFileName.trim().length === 0) {
    throw new ManualProofError(
      "manual_proof_object_key_invalid",
      "Nama berkas bukti transfer wajib diisi",
      400,
    );
  }

  return { r2Key, originalFileName };
};

/** The caller's payment, or the same non-committal 404 for every reason they cannot see one. */
const requirePaymentView = async (registrationId: string, userId: string) => {
  const view = await loadCandidatePaymentView(registrationId, userId);
  if (!view) {
    throw new ManualProofError("manual_proof_payment_not_found", "Pembayaran tidak ditemukan", 404);
  }
  return view;
};

const toErrorResponse = (error: unknown): Response => {
  if (error instanceof ManualProofError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return toAccessDeniedResponse(error);
};

// POST records the FIRST bukti transfer for this registration's payment.
//
// Split from PUT deliberately rather than collapsed into one upsert. A resubmission must pass
// through the organiser's resubmission bar, and an endpoint that decided between "insert" and
// "update" by looking for an existing row would route a barred candidate to the insert path, which
// has no bar to respect. Two verbs, two services, two different rules.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { registrationId } = await context.params;

    const body = await readProofBody(request);
    const view = await requirePaymentView(registrationId, session.user.id);

    const proof = await submitManualPaymentProof({
      paymentId: view.paymentId,
      submittedByUserId: session.user.id,
      ...body,
    });

    return NextResponse.json({ proof }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

// PUT records a REPLACEMENT bukti transfer after a rejection the organiser left open, or a void.
//
// The proof id is resolved from the caller's own payment rather than accepted from the body: a
// candidate has exactly one proof per payment, so there is nothing for them to choose, and
// accepting an id would create a parameter whose only use is to name someone else's row.
export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { registrationId } = await context.params;

    const body = await readProofBody(request);
    const view = await requirePaymentView(registrationId, session.user.id);

    if (!view.proof) {
      throw new ManualProofError(
        "manual_proof_not_found",
        "Belum ada bukti transfer untuk dikirim ulang",
        404,
      );
    }

    const proof = await reopenManualPaymentProof({
      proofId: view.proof.id,
      submittedByUserId: session.user.id,
      ...body,
    });

    return NextResponse.json({ proof }, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
