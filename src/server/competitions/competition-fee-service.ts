import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-fee-service");

import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions } from "@/server/db/schema";
import {
  assertCompetitionAccess,
  assertInstitutionVerified,
} from "@/server/competitions/competition-access";
import { CompetitionError } from "@/server/competitions/competition-core";
import { isMinorUnitAmount, isSupportedCurrency } from "@/lib/finance/money";
import { isValidPaymentWindowDays } from "@/lib/finance/payment-window";
import { requireFeeRuleInForce } from "@/server/finance/fee-rule-service";
import { requirePaymentInstructions } from "@/server/institutions/payment-instructions-service";
import { financeFeeDisclosureAcknowledgements } from "@/server/db/schema";
import {
  classifyCompetitionEdit,
  type EditClassificationSnapshot,
} from "@/server/competitions/edit-classification";
import {
  loadCompetitionPricing,
  loadEditClassificationSnapshot,
  toClassifiable,
  type CompetitionPricing,
} from "@/server/competitions/competition-service";
import { enqueueCompetitionEdited } from "@/server/async/enqueue";

// THE FEE-SETTING WRITE PATH — the one place a competition's price is written.
//
// `feeAmount` and `feeCurrency` are both in competition-core's SILENT_STRIP_FIELDS, so the create
// and patch endpoints drop them without error and no other service writes either column. Every
// price change in the system passes through here, which is what lets the guards below be complete
// rather than merely present.
//
// Six gates, in an order chosen so the cheapest refusal that is also the most informative comes
// first, and so nothing about the platform's pricing configuration leaks to someone who is not
// allowed to charge at all:
//
//   1. Ownership     — assertCompetitionAccess admin.
//   2. Edit matrix   — classifyCompetitionEdit. Carries BOTH the payment-in-flight block and the
//                      free-entrants block; see the note below on why they are not restated here.
//   3. Charging      — assertInstitutionVerified. Only for a NON-ZERO fee; setting a competition
//                      back to free is always allowed, including for an institution whose
//                      verification was just revoked. Revocation must not trap an organiser into
//                      keeping a price it can no longer honour.
//   4. Payable       — the institution must have published payment instructions. Only for a
//                      NON-ZERO fee. Enabling a price with nowhere to send the money produces a
//                      candidate who owes a debt they cannot discharge.
//   5. Priceable     — requireFeeRuleInForce (fail-closed). Only for a NON-ZERO fee.
//   6. Disclosed     — the organiser must have acknowledged the platform's rate, and the
//                      acknowledgement is RECORDED. Only for a NON-ZERO fee.
//
// THE EDIT MATRIX IS NOT RE-IMPLEMENTED HERE. The in-flight and free-entrants rules were previously
// written out a second time in this function, alongside the copies in `classifyCompetitionEdit`
// that the ordinary edit path uses. Two implementations of one rule are two things to keep in
// agreement, and the failure mode is silent: they diverge, and which one you get depends on which
// surface the organiser happened to use. The classifier is the single statement of the matrix and
// this path is now one of its two callers.

export type SetCompetitionFeeInput = {
  // Integer smallest unit (@/lib/finance/money). 0 or null both mean free.
  feeAmount: number | null;
  // Required whenever the fee is non-zero; ignored and cleared when it is not.
  feeCurrency: string | null;
  // Optional. Left unchanged when omitted.
  paymentWindowDays?: number;
  // The organiser confirming they have been shown what the platform charges. REQUIRED to enable a
  // price and refused when absent — a disclosure the organiser can skip is not a disclosure, and
  // the recorded acknowledgement is the platform's only evidence when a bill is later disputed.
  feeDisclosureAcknowledged?: boolean;
};

/**
 * Sets (or clears) a competition's registration fee.
 *
 * `pricedAt` is `now` by design: the question this gate asks is whether a rule is in force AT THE
 * MOMENT THE ORGANISER TURNS PRICING ON, which is when they need to be told that no rate is
 * configured. A payment resolves its own rule again at its own instant — the two are separate
 * questions and this one must not pre-empt the other.
 */
export const setCompetitionFee = async (
  actorUserId: string,
  competitionId: string,
  input: SetCompetitionFeeInput,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<void> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "admin", db);

  const feeAmount = input.feeAmount ?? 0;

  if (!isMinorUnitAmount(feeAmount) || feeAmount < 0) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "Biaya pendaftaran harus berupa bilangan bulat non-negatif",
      { fields: ["feeAmount"] },
    );
  }

  if (input.paymentWindowDays !== undefined && !isValidPaymentWindowDays(input.paymentWindowDays)) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "Batas waktu pembayaran tidak valid",
      { fields: ["paymentWindowDays"] },
    );
  }

  // THE EDIT MATRIX, evaluated by the same function the ordinary edit path uses.
  //
  // Everything the matrix knows about a price change arrives through here: the payment-in-flight
  // block, the free→paid block, and the notify classification. `paymentWindowDays` is threaded in
  // as the value that will actually be written, so an unchanged window classifies as unchanged
  // rather than as an edit nobody made.
  const pricing = await loadCompetitionPricing(competitionId, db);
  const nextPricing: CompetitionPricing = {
    feeAmount,
    feeCurrency: feeAmount > 0 ? input.feeCurrency : null,
    paymentWindowDays: input.paymentWindowDays ?? pricing.paymentWindowDays,
  };

  const snapshot = await loadEditClassificationSnapshot(competitionId, db);
  const classification = classifyCompetitionEdit(
    toClassifiable(competition, pricing),
    toClassifiable(competition, nextPricing),
    snapshot,
  );

  if (classification.blocked.length > 0) {
    throw toBlockedFeeEditError(classification.blocked, snapshot);
  }

  const isCharging = feeAmount > 0;

  if (!isCharging) {
    // Clearing a fee needs none of the gates below. They exist to stop money being taken; none of
    // them has anything to say about stopping.
    await writeFee(competitionId, null, null, input.paymentWindowDays, db);
    await notifyFeeEdit(competitionId, competition.status, classification.notify);
    return;
  }

  const currency = input.feeCurrency;

  if (currency === null || !isSupportedCurrency(currency)) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "Mata uang wajib diisi dan harus didukung ketika biaya pendaftaran lebih dari nol",
      { fields: ["feeCurrency"] },
    );
  }

  await assertInstitutionVerified(competition.institutionId, db);

  // NOWHERE TO SEND THE MONEY IS NOT A CHARGEABLE STATE. The payer transfers directly into the
  // institution's own account, so an institution that has published none leaves a candidate owing
  // a debt with no way to discharge it and no party able to tell them where to send it.
  await requirePaymentInstructions(competition.institutionId, db);

  // FAIL-CLOSED FEE RESOLUTION. `resolveFeeRule` returning null is a real state — no commercial
  // rate is seeded — and treating it as zero here would let an organiser switch pricing on, take
  // real money, and accrue nothing, with every downstream assertion passing. A refusal is
  // recoverable by configuring a rule; a ledger of silently free transactions is not.
  const rule = await requireFeeRuleInForce(competition.institutionId, now, db);

  if (input.feeDisclosureAcknowledged !== true) {
    throw new CompetitionError(
      "competition_fee_disclosure_required",
      422,
      "Setujui rincian biaya layanan Lombakita sebelum mengaktifkan pendaftaran berbayar",
      { fields: ["feeDisclosureAcknowledged"] },
    );
  }

  // The acknowledgement and the price land together or not at all. An acknowledgement recorded
  // against a fee that was never written would evidence consent to a bill nobody incurred, and a
  // price written without one is the evidence gap this whole gate exists to close.
  await db.transaction(async (tx) => {
    await tx.insert(financeFeeDisclosureAcknowledgements).values({
      competitionId,
      institutionId: competition.institutionId,
      acknowledgedByUserId: actorUserId,
      feeRuleId: rule.id,
      feeBasisPoints: rule.basisPoints,
      feeFlatAmount: rule.flatAmount,
      feeAmount,
      feeCurrency: currency,
    });

    await writeFee(competitionId, feeAmount, currency, input.paymentWindowDays, tx);
  });

  await notifyFeeEdit(competitionId, competition.status, classification.notify);
};

/**
 * Turns the classifier's blocked-field list into the refusal an organiser can act on.
 *
 * The classifier reports WHICH fields are blocked but not why, because it is pure and the reason
 * lives in the snapshot it was handed. Both causes block the same fields, so the snapshot is what
 * separates them — and telling an organiser "someone is mid-payment" when the real cause is "you
 * already have free registrants" sends them to wait for something that will never resolve.
 */
const toBlockedFeeEditError = (
  blocked: string[],
  snapshot: EditClassificationSnapshot,
): CompetitionError => {
  if (snapshot.hasPaymentInFlight) {
    return new CompetitionError(
      "competition_fee_change_blocked_payment_in_flight",
      409,
      "Biaya tidak dapat diubah selama masih ada bukti transfer yang menunggu verifikasi",
      { fields: blocked },
    );
  }

  return new CompetitionError(
    "competition_fee_blocked_free_registrations",
    409,
    "Biaya tidak dapat ditetapkan karena sudah ada pendaftar yang mendaftar tanpa biaya",
    { fields: blocked },
  );
};

/**
 * Fans out the participant-facing notice for a price change, on a PUBLISHED competition only.
 *
 * A draft has no registrations to notify, and classifying its first price as a change would
 * announce an edit to nobody about a competition that has never been visible. Fire-and-forget for
 * the same reason the ordinary edit path is: an enqueue failure must not fail the price change that
 * has already been written.
 */
const notifyFeeEdit = async (
  competitionId: string,
  status: string,
  changedFields: string[],
): Promise<void> => {
  if (status !== "published" || changedFields.length === 0) return;

  enqueueCompetitionEdited({
    competitionId,
    changedFields,
    epoch: Date.now(),
  }).catch(() => {
    // Swallowed deliberately; the price is already persisted and the enqueue is best-effort.
  });
};

const writeFee = async (
  competitionId: string,
  feeAmount: number | null,
  feeCurrency: string | null,
  paymentWindowDays: number | undefined,
  db: Database,
): Promise<void> => {
  const [row] = await db
    .update(competitions)
    .set({
      feeAmount,
      feeCurrency,
      ...(paymentWindowDays === undefined ? {} : { paymentWindowDays }),
      updatedAt: sql`now()`,
    })
    .where(and(eq(competitions.id, competitionId)))
    .returning({ id: competitions.id });

  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }
};
