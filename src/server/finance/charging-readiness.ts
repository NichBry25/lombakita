import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/charging-readiness");

import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { institutions } from "@/server/db/schema";
import { loadInstitutionVerificationStatus } from "@/server/competitions/competition-access";
import { hasPaymentInstructions } from "@/server/institutions/payment-instructions-service";
import { resolveFeeRule } from "@/server/finance/fee-rule-service";

// WHETHER AN INSTITUTION CAN TAKE MONEY RIGHT NOW, asked without throwing.
//
// A PAID COMPETITION OWNED BY AN UNVERIFIED INSTITUTION IS A DEFINED RUNTIME STATE (DEC-0170). It
// is not a data defect, it is not an error to swallow, and it is not something to discover by
// clicking register: verification can be revoked after a competition was priced and published, and
// the platform's answer to that is to stop new charging, not to take anything down.
//
// The three conditions are exactly the ones `createPayment` enforces, read through the same
// non-throwing helpers the gates themselves use, so a surface saying "this organiser cannot take
// payment" and the write path refusing to create one cannot disagree.
//
// VERIFICATION GATES CHARGING, NEVER PUBLISHING (DEC-0118 unchanged). Nothing here can unpublish a
// competition or hide it, and the copy built on it must not suggest otherwise — an organiser whose
// verification lapses keeps every competition they have already published.

export type ChargingBlocker =
  /** Verification is absent, pending or revoked. Only the organiser is told which condition failed. */
  | "institution_unverified"
  /** No bank account or QRIS has been published, so a payer would have nowhere to send money. */
  | "payment_instructions_missing"
  /** No platform fee rule is in force, so a payment cannot be priced (fail-closed). */
  | "fee_rule_not_in_force";

export type ChargingReadiness = {
  ready: boolean;
  /** Empty when ready. Ordered as the organiser should act on them. */
  blockers: ChargingBlocker[];
};

/**
 * Every reason this institution cannot currently charge, not just the first.
 *
 * All three are evaluated rather than short-circuited, because this feeds a panel whose whole job
 * is to tell an organiser what to fix. Reporting one blocker at a time turns a single task into
 * three round trips through a verification queue.
 */
export const resolveChargingReadiness = async (
  institutionId: string,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<ChargingReadiness> => {
  const [verificationStatus, instructionsPublished, feeRule] = await Promise.all([
    loadInstitutionVerificationStatus(institutionId, db),
    hasPaymentInstructions(institutionId, db),
    resolveFeeRule(institutionId, now, db),
  ]);

  const blockers: ChargingBlocker[] = [];

  if (verificationStatus !== "verified") blockers.push("institution_unverified");
  if (!instructionsPublished) blockers.push("payment_instructions_missing");
  if (feeRule === null) blockers.push("fee_rule_not_in_force");

  return { ready: blockers.length === 0, blockers };
};

/**
 * The same question asked by slug, for surfaces that only know the public identifier.
 *
 * Exists so the institution's internal id does not have to be added to `PublicCompetitionDetail`
 * to answer it. That type is serialised whole by the public competition endpoint, so a field added
 * for a server-side lookup would be published to unauthenticated callers as a side effect.
 *
 * An unknown slug reports NOT ready with no blockers: there is no institution to charge on behalf
 * of, and inventing a blocker would describe a configuration problem where there is simply no row.
 */
export const resolveChargingReadinessBySlug = async (
  institutionSlug: string,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<ChargingReadiness> => {
  const [row] = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.slug, institutionSlug.trim().toLowerCase()))
    .limit(1);

  if (!row) return { ready: false, blockers: [] };

  return resolveChargingReadiness(row.id, now, db);
};
