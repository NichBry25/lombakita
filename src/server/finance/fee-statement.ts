import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/fee-statement");

import { and, desc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  financeFeeAccruals,
  financeFeeDisclosureAcknowledgements,
  financePayments,
} from "@/server/db/schema";
import type { FeeAccrualEntryType } from "@/lib/finance/payment-model";

// WHAT THIS INSTITUTION OWES THE PLATFORM, AND WHY IT OWES IT.
//
// DEC-0163 sets the direction, and it is the opposite of everything else in this lane: the accrual
// is a RECEIVABLE the institution owes Lombakita, not money Lombakita is holding for them. Under
// DEC-0130 the participant's transfer went straight into the institution's own bank account and the
// platform never touched it — so the platform's service fee was never deducted from anything. It is
// billed afterwards. A statement that reads like a balance would invert that completely and invite
// an organiser to wait for a payout that is never coming.
//
// EVERY RATE HERE COMES FROM THE ACCRUAL'S OWN SNAPSHOT (DEC-0171), never from the fee rule as it
// stands today. The rule is versioned by effective date and a later one supersedes it, so rendering
// the current rate against a historical line would show a figure that was never charged — and it
// would be wrong in exactly the direction that starts a billing dispute.
//
// READ-ONLY, AND NOT AN INVOICE (R8). There is no payment instruction, no due date and no reversal
// action: this step records what has accrued, and nothing in the product settles it yet. A surface
// that acquires a "pay now" has left its scope.

export type FeeStatementLine = {
  accrualId: string;
  entryType: FeeAccrualEntryType;
  /**
   * The amount AS STORED, which is already signed: positive on `accrued`, negative on `reversed`
   * (`recordFeeAccrualReversal` writes the exact negation). Summing this column over every line
   * gives the outstanding receivable directly — do NOT negate a `reversed` row again on the way
   * past, which double-counts it in the direction that overstates what the institution owes.
   */
  signedAmount: number;
  amount: number;
  currency: string;
  /** The registration fee this fee was computed FROM — the accrual's own snapshot of it. */
  grossAmount: number;
  /** The rate as it stood when this line was priced. Never today's rate. */
  feeBasisPoints: number;
  feeFlatAmount: number;
  competitionTitle: string | null;
  reason: string | null;
  recordedAt: Date;
};

export type FeeStatementAcknowledgement = {
  competitionId: string;
  competitionTitle: string;
  feeBasisPoints: number;
  feeFlatAmount: number;
  feeAmount: number;
  feeCurrency: string;
  acknowledgedAt: Date;
};

export type InstitutionFeeStatement = {
  lines: FeeStatementLine[];
  /**
   * The signed sum of every line, in minor units — the same arithmetic
   * `sumOutstandingFeeAccruals` performs, so the figure on this page and the figure any other
   * caller reads cannot drift. The receivable, not a balance.
   */
  outstandingAmount: number;
  /** The `accrued` arm alone, positive. */
  accruedAmount: number;
  /** The MAGNITUDE walked back by `reversed` rows, positive for display against a "−" prefix. */
  reversedAmount: number;
  currency: string | null;
  acknowledgements: FeeStatementAcknowledgement[];
};

/**
 * Every platform-fee line this institution has accrued, newest first, with what it agreed to.
 *
 * Scoped on `owing_institution_id` in the WHERE rather than filtered afterwards, for the reason
 * every other read in this lane is: a post-filter is one a later call site can forget, and this
 * query reaches money owed by a specific tenant.
 */
export const loadInstitutionFeeStatement = async (
  institutionId: string,
  db: Database = getDb(),
): Promise<InstitutionFeeStatement> => {
  const rows = await db
    .select({
      accrualId: financeFeeAccruals.id,
      entryType: financeFeeAccruals.entryType,
      amount: financeFeeAccruals.amount,
      currency: financeFeeAccruals.currency,
      grossAmount: financeFeeAccruals.grossAmount,
      // FROM THE ACCRUAL, not from finance_fee_rules. Joining the rule table here would render the
      // rate as it stands now against a line priced under a rule that has since been superseded.
      feeBasisPoints: financeFeeAccruals.feeBasisPoints,
      feeFlatAmount: financeFeeAccruals.feeFlatAmount,
      reason: financeFeeAccruals.reason,
      recordedAt: financeFeeAccruals.createdAt,
      competitionTitle: competitions.title,
    })
    .from(financeFeeAccruals)
    .innerJoin(financePayments, eq(financePayments.id, financeFeeAccruals.paymentId))
    // LEFT from here on. The null branch is currently UNREACHABLE — `subject_xor` forbids clearing
    // the registration id, and the payment's FK to the registration is NO ACTION, so a competition
    // delete cannot cascade past it — but the fee is owed on the PAYMENT, so an inner join would
    // silently drop the line the day either of those loosens. Understating a receivable without
    // saying so is worse than a row with a blank competition.
    .leftJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, financePayments.competitionRegistrationId),
    )
    .leftJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .where(eq(financeFeeAccruals.owingInstitutionId, institutionId))
    .orderBy(desc(financeFeeAccruals.createdAt));

  const lines: FeeStatementLine[] = rows.map((row) => ({
    accrualId: row.accrualId,
    entryType: row.entryType,
    signedAmount: row.amount,
    amount: row.amount,
    currency: row.currency,
    grossAmount: row.grossAmount,
    feeBasisPoints: row.feeBasisPoints,
    feeFlatAmount: row.feeFlatAmount,
    competitionTitle: row.competitionTitle,
    reason: row.reason,
    recordedAt: row.recordedAt,
  }));

  const accruedAmount = sumWhere(lines, "accrued");
  // Negated on the way out, because the stored row is ALREADY negative. This is the only place the
  // sign is flipped, and it is flipped for presentation alone — the outstanding total below never
  // passes through it.
  const reversedAmount = -sumWhere(lines, "reversed");

  return {
    lines,
    accruedAmount,
    reversedAmount,
    // Netted from the rows rather than stored anywhere: the accrual table is append-only, so a
    // correction is a new `reversed` row and any cached total would be a second copy of a fact the
    // rows already carry.
    outstandingAmount: lines.reduce((total, line) => total + line.signedAmount, 0),
    currency: lines[0]?.currency ?? null,
    acknowledgements: await loadAcknowledgements(institutionId, db),
  };
};

/** The signed sum of one arm. `reversed` therefore returns a NON-POSITIVE number. */
const sumWhere = (lines: FeeStatementLine[], entryType: FeeAccrualEntryType): number =>
  lines
    .filter((line) => line.entryType === entryType)
    .reduce((total, line) => total + line.amount, 0);

/**
 * What this institution agreed to, and when — R2's record, surfaced.
 *
 * The acknowledgement is what makes the receivable defensible: it is the moment an owner was shown
 * the exact split for a specific price and accepted it, snapshotted with the rate that was on
 * screen. Showing the statement without it would present a bill whose basis lives only in a table
 * nobody outside engineering can read.
 */
const loadAcknowledgements = async (
  institutionId: string,
  db: Database,
): Promise<FeeStatementAcknowledgement[]> => {
  const rows = await db
    .select({
      competitionId: financeFeeDisclosureAcknowledgements.competitionId,
      competitionTitle: competitions.title,
      feeBasisPoints: financeFeeDisclosureAcknowledgements.feeBasisPoints,
      feeFlatAmount: financeFeeDisclosureAcknowledgements.feeFlatAmount,
      feeAmount: financeFeeDisclosureAcknowledgements.feeAmount,
      feeCurrency: financeFeeDisclosureAcknowledgements.feeCurrency,
      acknowledgedAt: financeFeeDisclosureAcknowledgements.acknowledgedAt,
    })
    .from(financeFeeDisclosureAcknowledgements)
    .innerJoin(competitions, eq(competitions.id, financeFeeDisclosureAcknowledgements.competitionId))
    .where(
      and(
        eq(financeFeeDisclosureAcknowledgements.institutionId, institutionId),
        // The competition must still belong to this institution. The acknowledgement carries its
        // own institution id, but a competition that moved tenants would otherwise surface another
        // institution's title against this one's agreement.
        eq(competitions.institutionId, institutionId),
      ),
    )
    .orderBy(desc(financeFeeDisclosureAcknowledgements.acknowledgedAt));

  return rows;
};
