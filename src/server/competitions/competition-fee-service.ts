import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-fee-service");

import { and, eq, sql } from "drizzle-orm";
import { acquireCompetitionParticipationLock } from "@/server/competitions/competition-participation-lock";
import { getDb, type Database } from "@/server/db/client";
import { competitions, type CompetitionStatus } from "@/server/db/schema";
import {
  assertCompetitionAccess,
  assertInstitutionVerified,
  hasActiveRegistrationsForCompetition,
  type CompetitionRow,
} from "@/server/competitions/competition-access";
import { CompetitionError } from "@/server/competitions/competition-core";
import { isMinorUnitAmount, isSupportedCurrency } from "@/lib/finance/money";
import { isValidPaymentWindowDays } from "@/lib/finance/payment-window";
import { requireFeeRuleInForce } from "@/server/finance/fee-rule-service";
import { requirePaymentInstructions } from "@/server/institutions/payment-instructions-service";
import { financeFeeDisclosureAcknowledgements } from "@/server/db/schema";
import {
  classifyCompetitionEdit,
  type EditClassification,
} from "@/server/competitions/edit-classification";
import {
  loadCompetitionPricing,
  loadEditClassificationSnapshot,
  toClassifiable,
  type CompetitionPricing,
} from "@/server/competitions/competition-service";
import { enqueueCompetitionEdited } from "@/server/async/enqueue";
import {
  COMPETITION_CHANGED_DURING_EDIT_REASON,
  DRAFT_PRICE_HELD_BY_REGISTRATIONS_REASON,
  PUBLISH_LOCK_REASONS,
} from "@/lib/competitions/publish-locks";

// THE FEE-SETTING WRITE PATH. The one place a competition's price is written.
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
//   1. Ownership:      assertCompetitionAccess "admin", which is institution_owner ALONE. Setting
//                      a price binds the institution to a receivable, so it sits with the party
//                      that can be bound.
//   2. Publish lock:   the competition's status, read under the participation lock and compared
//                      again by the write. After publish classifyCompetitionEdit refuses a new
//                      amount or currency, and only the payment window still moves. A draft takes
//                      any price unless it still holds a non-cancelled registration.
//   3. Charging:       assertInstitutionVerified. Only for a NON-ZERO fee, so a draft that gate 2
//                      lets change its price can always go back to free, including for an
//                      institution whose verification was just revoked. Revocation must not trap
//                      an organiser into keeping a price it can no longer honour.
//   4. Payable:        the institution must have published payment instructions. Only for a
//                      NON-ZERO fee. Enabling a price with nowhere to send the money produces a
//                      candidate who owes a debt they cannot discharge.
//   5. Priceable:      requireFeeRuleInForce (fail-closed). Only for a NON-ZERO fee.
//   6. Disclosed:      the organiser must have acknowledged the platform's rate, and the
//                      acknowledgement is RECORDED. Only for a NON-ZERO fee.
//
// THE EDIT MATRIX IS NOT RE-IMPLEMENTED HERE. The classifier is the single statement of what a
// published competition may change, the ordinary edit path asks it too, and both write paths in
// this file call it. Two statements of one rule drift apart silently, and which one applied
// would depend on which surface the organiser happened to use.

export type SetCompetitionFeeInput = {
  // Integer smallest unit (@/lib/finance/money). 0 or null both mean free.
  feeAmount: number | null;
  // Required whenever the fee is non-zero; ignored and cleared when it is not.
  feeCurrency: string | null;
  // Optional. Left unchanged when omitted.
  paymentWindowDays?: number;
  // The organiser confirming they have been shown what the platform charges. REQUIRED to enable a
  // price and refused when absent. A disclosure the organiser can skip is not a disclosure, and
  // the recorded acknowledgement is the platform's only evidence when a bill is later disputed.
  feeDisclosureAcknowledged?: boolean;
};

/**
 * Sets (or clears) a competition's registration fee.
 *
 * `pricedAt` is `now` by design: the question this gate asks is whether a rule is in force AT THE
 * MOMENT THE ORGANISER TURNS PRICING ON, which is when they need to be told that no rate is
 * configured. A payment resolves its own rule again at its own instant. The two are separate
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

  // THE PUBLISH LOCK, decided by the same classifier the ordinary edit path uses.
  //
  // A draft with nobody registered takes any price, and nobody is told about it. Once the
  // competition is published the classifier refuses any change to the amount or the currency, and
  // `paymentWindowDays` is threaded in as the value that will actually be written, so a window
  // moved at an unchanged price is announced rather than refused.
  //
  // ONE TRANSACTION, UNDER THE PARTICIPATION LOCK, from the status read to the write. A candidate
  // registers only on a published competition and takes the same lock to do it, so reading the
  // status under the lock means no one registers at the old price and then owes a new one. The
  // advisory lock is the same one every other path that reasons about the participation set takes:
  // registration, team registration, participation changes, results, unpublish, the operator's
  // cancellation, and a proof upload or refile.
  const { lockedStatus, notify } = await db.transaction(async (tx) => {
    await acquireCompetitionParticipationLock(tx, competitionId);

    const status = await loadCompetitionStatus(competitionId, tx);
    const pricing = await loadCompetitionPricing(competitionId, tx);
    const nextPricing: CompetitionPricing = {
      feeAmount,
      feeCurrency: feeAmount > 0 ? input.feeCurrency : null,
      paymentWindowDays: input.paymentWindowDays ?? pricing.paymentWindowDays,
    };

    const classification = await classifyPricingChange(competition, pricing, nextPricing, tx);
    // Both sides share every field but the price, so a blocked field is the amount or the currency.
    const priceChanges = classification.blocked.length > 0;
    if (priceChanges && status !== "draft") {
      throw new CompetitionError(
        "competition_fee_locked_after_publish",
        409,
        PUBLISH_LOCK_REASONS.feeAmount,
        { fields: classification.blocked },
      );
    }
    if (priceChanges) {
      await assertDraftPriceMayChange(competitionId, classification.blocked, tx);
    }
    const announcedFields = status === "draft" ? [] : classification.notify;

    const isCharging = feeAmount > 0;

    if (!isCharging) {
      // Clearing a fee needs none of the gates below. They exist to stop money being taken; none
      // of them has anything to say about stopping.
      await writeFee(competitionId, null, null, input.paymentWindowDays, status, tx);
      return { lockedStatus: status, notify: announcedFields };
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

    await assertInstitutionVerified(competition.institutionId, tx);

    // NOWHERE TO SEND THE MONEY IS NOT A CHARGEABLE STATE. The payer transfers directly into the
    // institution's own account, so an institution that has published none leaves a candidate owing
    // a debt with no way to discharge it and no party able to tell them where to send it.
    await requirePaymentInstructions(competition.institutionId, tx);

    // FAIL-CLOSED FEE RESOLUTION. `resolveFeeRule` returning null is a real state (no commercial
    // rate is seeded) and treating it as zero here would let an organiser switch pricing on, take
    // real money, and accrue nothing, with every downstream assertion passing. A refusal is
    // recoverable by configuring a rule; a ledger of silently free transactions is not.
    const rule = await requireFeeRuleInForce(competition.institutionId, now, tx);

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

    await writeFee(competitionId, feeAmount, currency, input.paymentWindowDays, status, tx);

    return { lockedStatus: status, notify: announcedFields };
  });

  // AFTER COMMIT, matching every other path in this lane: a notification for a price change that
  // was rolled back is a message about something that did not happen. It announces from the status
  // the write was judged under, because a publish can land between the first read and the lock.
  await notifyFeeEdit(competitionId, lockedStatus, notify);
};

// THE WINDOW-ONLY WRITE PATH. Staff of the institution may move the payment window of a fee the
// owner already turned on (DEC-0179 keeps the price and the consent with the owner). It writes no
// consent row and no price, so the consent on file still matches the stored fee, and it has none
// of the charging gates, because it cannot turn money on. It holds the participation lock so the
// fee it found on cannot be turned off under it, and it asks the edit matrix only which fields to
// announce, because the matrix never blocks a window change.
export const setCompetitionPaymentWindow = async (
  actorUserId: string,
  competitionId: string,
  paymentWindowDays: number,
  db: Database = getDb(),
): Promise<void> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);

  if (!isValidPaymentWindowDays(paymentWindowDays)) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "Batas waktu pembayaran tidak valid",
      { fields: ["paymentWindowDays"] },
    );
  }

  const notify = await db.transaction(async (tx) => {
    await acquireCompetitionParticipationLock(tx, competitionId);

    const pricing = await loadCompetitionPricing(competitionId, tx);
    if (pricing.feeAmount === null || pricing.feeAmount <= 0) {
      throw new CompetitionError(
        "competition_fee_not_enabled",
        409,
        "Biaya pendaftaran belum aktif. Hanya pemilik institusi yang dapat mengaktifkannya.",
        { fields: ["paymentWindowDays"] },
      );
    }
    const nextPricing: CompetitionPricing = { ...pricing, paymentWindowDays };

    const snapshot = await loadEditClassificationSnapshot(competitionId, tx);
    const classification = classifyCompetitionEdit(
      toClassifiable(competition, pricing),
      toClassifiable(competition, nextPricing),
      snapshot,
    );

    await writePaymentWindow(competitionId, paymentWindowDays, tx);

    return classification.notify;
  });

  await notifyFeeEdit(competitionId, competition.status, notify);
};

/**
 * The competition's status, read inside the price change's transaction after the participation
 * lock, so it is the status a registration taking the same lock also sees.
 */
const loadCompetitionStatus = async (
  competitionId: string,
  db: Database,
): Promise<CompetitionStatus> => {
  const [row] = await db
    .select({ status: competitions.status })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);

  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }

  return row.status;
};

/**
 * Classifies a price change with the classifier the ordinary edit path uses. Its blocked list names
 * the amount or the currency when either changed.
 */
const classifyPricingChange = async (
  competition: CompetitionRow,
  pricing: CompetitionPricing,
  nextPricing: CompetitionPricing,
  db: Database,
): Promise<EditClassification> => {
  const snapshot = await loadEditClassificationSnapshot(competition.id, db);
  return classifyCompetitionEdit(
    toClassifiable(competition, pricing),
    toClassifiable(competition, nextPricing),
    snapshot,
  );
};

/**
 * Refuses a new price on a draft that still holds a non-cancelled registration, which would owe a
 * price it never agreed to.
 */
const assertDraftPriceMayChange = async (
  competitionId: string,
  changedFields: string[],
  db: Database,
): Promise<void> => {
  if (await hasActiveRegistrationsForCompetition(competitionId, db)) {
    throw new CompetitionError(
      "competition_fee_blocked_active_registrations",
      409,
      DRAFT_PRICE_HELD_BY_REGISTRATIONS_REASON,
      { fields: changedFields },
    );
  }
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

// Writes the price only onto the status it was judged under, so a publish that commits after the
// status read matches no row and the change is refused instead of landing on a published row.
const writeFee = async (
  competitionId: string,
  feeAmount: number | null,
  feeCurrency: string | null,
  paymentWindowDays: number | undefined,
  judgedStatus: CompetitionStatus,
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
    .where(and(eq(competitions.id, competitionId), eq(competitions.status, judgedStatus)))
    .returning({ id: competitions.id });

  if (!row) {
    throw new CompetitionError(
      "competition_changed_during_edit",
      409,
      COMPETITION_CHANGED_DURING_EDIT_REASON,
    );
  }
};

const writePaymentWindow = async (
  competitionId: string,
  paymentWindowDays: number,
  db: Database,
): Promise<void> => {
  const [row] = await db
    .update(competitions)
    .set({ paymentWindowDays, updatedAt: sql`now()` })
    .where(eq(competitions.id, competitionId))
    .returning({ id: competitions.id });

  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }
};
