import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { assertSessionMatchesExpectedUser, toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionError,
  toCompetitionErrorResponse,
} from "@/server/competitions/competition-core";
import { assertCompetitionAccess } from "@/server/competitions/competition-access";
import { loadCompetitionPricing } from "@/server/competitions/competition-service";
import { setCompetitionFee } from "@/server/competitions/competition-fee-service";
import { resolveFeeRule, toFeeRuleTerms } from "@/server/finance/fee-rule-service";
import { computePlatformFee } from "@/lib/finance/fee";
import { FeeRuleError } from "@/server/finance/fee-rule-service";
import { PaymentInstructionsError } from "@/server/institutions/payment-instructions-service";

type RouteContext = { params: Promise<{ competitionId: string }> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// THREE ERROR FAMILIES REACH THIS ROUTE, and only one of them is a CompetitionError.
//
// `setCompetitionFee`'s six gates draw on three services, so a handler that converts only its own
// module's error type sends the other two to `toAccessDeniedResponse`, which answers anything it
// does not recognise with HTTP 500 "Unexpected access-guard failure". That is what the R12
// precondition — by far the most likely legitimate refusal here, an organiser who has not yet
// published their bank details — produced before this function existed: an English internal error
// for an ordinary, recoverable, self-service state.
//
// The two non-Competition families also carry English messages, because until this surface they had
// no organiser-facing caller. They are translated at the boundary rather than in the services,
// which are shared with platform_ops tooling where the English text is correct.
const FEE_RULE_MESSAGES_ID: Partial<Record<FeeRuleError["code"], string>> = {
  fee_rule_not_in_force:
    "Tarif layanan Lombakita belum dikonfigurasi, sehingga pendaftaran berbayar belum dapat diaktifkan. Hubungi tim Lombakita.",
  fee_rule_currency_unsupported:
    "Mata uang pada tarif layanan tidak didukung. Hubungi tim Lombakita.",
  fee_rule_takes_entire_payment:
    "Tarif layanan yang berlaku akan mengambil seluruh pembayaran peserta. Hubungi tim Lombakita.",
};

const refuse = (error: unknown): Response => {
  if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);

  if (error instanceof PaymentInstructionsError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message:
            "Lengkapi informasi pembayaran lembaga Anda sebelum mengaktifkan pendaftaran berbayar.",
        },
      },
      { status: error.status },
    );
  }

  if (error instanceof FeeRuleError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: FEE_RULE_MESSAGES_ID[error.code] ?? "Tarif layanan Lombakita tidak dapat digunakan saat ini.",
        },
      },
      { status: error.status },
    );
  }

  return toAccessDeniedResponse(error);
};

// A SUB-RESOURCE rather than fields on the competition PATCH, and not by preference: `feeAmount`
// and `feeCurrency` are in competition-core's SILENT_STRIP_FIELDS, so the PATCH drops them without
// error. Every price change in the system goes through `setCompetitionFee`, which is what lets its
// six gates be complete rather than merely present — a second write path would defeat all of them.
//
// STAFF-CAPABLE (`assertCompetitionAccess` admin), unlike the payment-instructions surface, which
// is owner-only. The distinction is deliberate: owner-only there prevents one role from both
// redirecting funds and confirming their receipt. Setting a PRICE cannot divert anything — the
// destination account stays owner-controlled — so the same restriction here would block routine
// competition work without closing a diversion path. What staff can do is incur a platform fee,
// and the disclosure acknowledgement records exactly who did.

// GET — the current price plus what the platform would charge against it.
//
// The rate is returned so the form can DISCLOSE it before asking for consent. It is read here with
// `resolveFeeRule` rather than `requireFeeRuleInForce`, because a missing rule is a state this
// screen must be able to render and explain; the WRITE path is the one that fails closed on it.
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { competitionId } = await context.params;
    const db = getDb();
    const { competition } = await assertCompetitionAccess(
      session.user.id,
      competitionId,
      "admin",
      db,
    );

    const pricing = await loadCompetitionPricing(competitionId, db);
    const rule = await resolveFeeRule(competition.institutionId, new Date(), db);

    // Previewed against the price currently set, so the organiser sees the actual figures rather
    // than a percentage they have to apply themselves.
    const preview =
      rule !== null && pricing.feeAmount !== null && pricing.feeAmount > 0
        ? computePlatformFee(pricing.feeAmount, toFeeRuleTerms(rule))
        : null;

    return NextResponse.json({
      pricing,
      feeRule:
        rule === null
          ? null
          : {
              basisPoints: rule.basisPoints,
              flatAmount: rule.flatAmount,
              currency: rule.currency,
              minimumFeeAmount: rule.minimumFeeAmount,
              maximumFeeAmount: rule.maximumFeeAmount,
            },
      preview,
    });
  } catch (error) {
    return refuse(error);
  }
}

// PUT — set or clear the price. Every gate lives in the service; this route reads the body and
// nothing else, so there is no second place for the rules to drift to.
export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);

    const { competitionId } = await context.params;
    const payload = await request.json().catch(() => null);
    const body = isRecord(payload) ? payload : {};

    await setCompetitionFee(
      session.user.id,
      competitionId,
      {
        feeAmount: typeof body.feeAmount === "number" ? body.feeAmount : null,
        feeCurrency: typeof body.feeCurrency === "string" ? body.feeCurrency : null,
        ...(typeof body.paymentWindowDays === "number"
          ? { paymentWindowDays: body.paymentWindowDays }
          : {}),
        // Strictly `=== true`. A truthy string or a 1 would let a client acknowledge by accident,
        // and this field is the platform's evidence of consent to a bill.
        feeDisclosureAcknowledged: body.feeDisclosureAcknowledged === true,
      },
      getDb(),
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return refuse(error);
  }
}
