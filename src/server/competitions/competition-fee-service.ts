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
import { hasCompetitionPaymentInFlight } from "@/server/finance/paid-registration";

// THE FEE-SETTING WRITE PATH — the one place a competition's price is written.
//
// PREMISE CORRECTION, stated here because a reader will otherwise look for the path this replaces.
// The step prompt refers to "the write path that sets a non-zero fee on a competition" as an
// existing surface to wire guards into. It did not exist: `feeAmount` and `feeCurrency` are both in
// competition-core's SILENT_STRIP_FIELDS, so the create and patch endpoints drop them without
// error, and no service anywhere wrote either column. This module IS that write path, created here
// so the guards have something real to sit on.
//
// It is a SERVICE WITH NO ROUTE, following the same pattern as the rest of this step: the
// organiser-facing surface that calls it belongs to 7.2-MANUAL.2, and adding one here would ship
// the organiser-transactional surface this step explicitly excludes. The guards below are live and
// tested; what is deferred is the button.
//
// Three gates, in an order chosen so the cheapest refusal that is also the most informative comes
// first, and so nothing about the platform's pricing configuration leaks to someone who is not
// allowed to charge at all:
//
//   1. Ownership   — assertCompetitionAccess admin.
//   2. Charging    — assertInstitutionVerified (DEC-0158). Only for a NON-ZERO fee; setting a
//                    competition back to free is always allowed, including for an institution whose
//                    verification was just revoked. Revocation must not trap an organiser into
//                    keeping a price it can no longer honour.
//   3. Priceable   — requireFeeRuleInForce (fail-closed). Only for a NON-ZERO fee.

export type SetCompetitionFeeInput = {
  // Integer smallest unit (@/lib/finance/money). 0 or null both mean free.
  feeAmount: number | null;
  // Required whenever the fee is non-zero; ignored and cleared when it is not.
  feeCurrency: string | null;
  // Optional. Left unchanged when omitted.
  paymentWindowDays?: number;
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

  // DEC-0132's sibling rule, at the write rather than only in the classifier: while somebody's
  // money is in flight, the price they are paying against cannot move underneath them.
  if (await hasCompetitionPaymentInFlight(competitionId, db)) {
    throw new CompetitionError(
      "competition_fee_change_blocked_payment_in_flight",
      409,
      "Biaya tidak dapat diubah selama masih ada bukti transfer yang menunggu verifikasi",
      { fields: ["feeAmount"] },
    );
  }

  const isCharging = feeAmount > 0;

  if (!isCharging) {
    // Clearing a fee needs neither gate. Both exist to stop money being taken; neither has anything
    // to say about stopping.
    await writeFee(competitionId, null, null, input.paymentWindowDays, db);
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

  // FAIL-CLOSED FEE RESOLUTION. `resolveFeeRule` returning null is a real state — no commercial
  // rate is seeded — and treating it as zero here would let an organiser switch pricing on, take
  // real money, and accrue nothing, with every downstream assertion passing. A refusal is
  // recoverable by configuring a rule; a ledger of silently free transactions is not.
  await requireFeeRuleInForce(competition.institutionId, now, db);

  await writeFee(competitionId, feeAmount, currency, input.paymentWindowDays, db);
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
