import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/ops-payment-service");

import { and, eq, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  platformOpsAuditLogs,
  type FinanceManualPaymentProofRecord,
} from "@/server/db/schema";
import { INSTITUTION_CANCELLATION_REASON } from "@/server/competitions/competition-lifecycle";
import {
  ManualProofError,
  voidManualPaymentProof,
} from "@/server/finance/manual-payment-proof-service";

// THE DEC-0132 ESCAPE HATCH. One operational surface, two actions, both platform_ops only.
//
// DEC-0132 blocks an ORGANISER from unpublishing while a bukti transfer is in flight, because doing
// so cancels every registration and would strand a candidate who has already transferred real
// rupiah. That block has to have a way out — an organiser with a genuine reason to cancel must not
// simply be stuck — and this is it: the same decision, made by someone who can also see the money
// and is accountable for the call.
//
// Both actions are AUDITED and both REQUIRE A REASON, because the whole justification for their
// existing is that a human took responsibility for overriding a participant protection.

const COMPETITION_CANCELLED_EVENT = "finance_ops_competition_cancelled";
const PROOF_VOIDED_EVENT = "finance_ops_payment_proof_voided";

export type OpsPaymentErrorCode = "ops_reason_required" | "ops_competition_not_found";

export class OpsPaymentError extends Error {
  constructor(
    public readonly code: OpsPaymentErrorCode,
    message: string,
    public readonly status: number = 422,
  ) {
    super(message);
    this.name = "OpsPaymentError";
  }
}

const requireReason = (reason: string): string => {
  const trimmed = reason.trim();

  if (trimmed.length === 0) {
    throw new OpsPaymentError(
      "ops_reason_required",
      "An operator action that overrides a participant protection must state its reason",
    );
  }

  return trimmed;
};

export type OpsCancelCompetitionResult = {
  competitionId: string;
  cancelledRegistrationCount: number;
};

/**
 * Cancels a competition on an organiser's behalf, past the DEC-0132 in-flight block.
 *
 * Deliberately does NOT clear the in-flight proofs. Voiding a proof is a separate, separately
 * audited decision (`voidPaymentProofAsOps`), and bundling it here would let one click both cancel
 * a competition and silently discard the evidence that someone paid for it. An operator cancelling
 * a competition with outstanding transfers is expected to resolve each of those transfers
 * explicitly.
 *
 * NO FINANCE EVENT IS WRITTEN. Cancelling a competition says nothing about whether any particular
 * transfer arrived, and the ledger only records what is known.
 */
export const cancelCompetitionAsOps = async (
  actorUserId: string,
  competitionId: string,
  reason: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<OpsCancelCompetitionResult> => {
  const auditReason = requireReason(reason);

  return db.transaction(async (tx) => {
    const [competition] = await tx
      .select({ id: competitions.id, institutionId: competitions.institutionId })
      .from(competitions)
      .where(eq(competitions.id, competitionId))
      .limit(1);

    if (!competition) {
      throw new OpsPaymentError("ops_competition_not_found", "Competition not found", 404);
    }

    const cancelledRows = await tx
      .update(competitionRegistrations)
      .set({
        status: "cancelled",
        cancellationReason: INSTITUTION_CANCELLATION_REASON,
        cancelledAt: now,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(competitionRegistrations.competitionId, competitionId),
          ne(competitionRegistrations.status, "cancelled"),
        ),
      )
      .returning({ id: competitionRegistrations.id });

    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      // A competition is not a user, and the audit table's target_present_chk requires a user or an
      // institution. The owning institution is the accountable party here, so it is the target.
      targetInstitutionId: competition.institutionId,
      eventType: COMPETITION_CANCELLED_EVENT,
      metadata: {
        competitionId,
        reason: auditReason,
        cancelledRegistrationCount: cancelledRows.length,
      },
    });

    return { competitionId, cancelledRegistrationCount: cancelledRows.length };
  });
};

/**
 * Voids a bukti transfer that is awaiting review, past the point an organiser can act on it.
 *
 * NO FINANCE EVENT IS WRITTEN, and this is the property that makes the action safe to expose.
 * Nothing was confirmed received, so there is nothing to record as succeeded, failed or refunded;
 * writing any event would put a claim about a payer's money into an append-only ledger that nobody
 * is in a position to make. The proof simply stops being in flight, which releases the DEC-0132
 * unpublish block.
 */
export const voidPaymentProofAsOps = async (
  actorUserId: string,
  proofId: string,
  reason: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<FinanceManualPaymentProofRecord> => {
  const auditReason = requireReason(reason);

  return db.transaction(async (tx) => {
    const proof = await voidManualPaymentProof(actorUserId, proofId, auditReason, tx, now);

    const [competition] = await tx
      .select({ institutionId: competitions.institutionId })
      .from(competitions)
      .where(eq(competitions.id, proof.competitionId))
      .limit(1);

    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      // Falls back to the actor when the competition somehow cannot be read, so the audit row is
      // still written: losing the audit trail is a worse outcome than an imprecise target, and the
      // metadata below carries the precise subject either way.
      targetUserId: competition ? undefined : actorUserId,
      targetInstitutionId: competition?.institutionId,
      eventType: PROOF_VOIDED_EVENT,
      metadata: {
        proofId: proof.id,
        paymentId: proof.paymentId,
        competitionId: proof.competitionId,
        reason: auditReason,
      },
    });

    return proof;
  });
};

export { ManualProofError };
