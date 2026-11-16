import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/ops-payment-service");

import { and, eq, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  financeManualPaymentProofs,
  financePayments,
  type FinanceManualPaymentProofRecord,
} from "@/server/db/schema";
import {
  assertOperatorHasNoInstitutionRelationship,
  OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
} from "@/server/institution-verification/operator-institution-conflict";
import {
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
} from "@/server/platform-ops/operator-actor";
import { assertOperatorIsNotPayer } from "@/server/finance/operator-payer-conflict";
import { INSTITUTION_CANCELLATION_REASON } from "@/server/competitions/competition-lifecycle";
import { acquireCompetitionParticipationLock } from "@/server/competitions/competition-participation-lock";
import {
  hasCompetitionPaymentInFlight,
  resolveActivePaymentGroupMemberUserIdsByPaymentId,
} from "@/server/finance/paid-registration";
import { disbandEveryTeamOfCompetition } from "@/server/teams/team-service";
import { markCompetitionRegistrationsPublicationClosed } from "@/server/registrations/registration-service";
import { enqueueCompetitionCancelled, enqueueCompetitionSearchSync } from "@/server/async/enqueue";
import { logger } from "@/lib/logger";
import {
  ManualProofError,
  voidManualPaymentProof,
} from "@/server/finance/manual-payment-proof-service";
import { notifyPaymentOutcome } from "@/server/finance/payment-notifications";

// THE PLATFORM_OPS PAYMENT ACTIONS. One operational surface, two actions, both platform_ops only.
//
// DEC-0132 blocks an ORGANISER from unpublishing while a bukti transfer is in flight, because doing
// so cancels every registration and would strand a candidate who has already transferred real
// rupiah. The way out is resolving each transfer: the organiser verifies or rejects it, or an
// operator voids one nobody will rule on. The operator's cancellation below holds to the same
// block, so no path takes a competition with a transfer in flight back to draft.
//
// Both actions are AUDITED and both REQUIRE A REASON, because each is an operator's decision over an
// organiser's competition or a payer's transfer, and the reason is the only record of why.

// Both actions are taken by platform_ops, so the event names say platform_ops. Naming them for the
// finance domain they happen to touch would split one operator's audit trail across two prefixes.
const COMPETITION_CANCELLED_EVENT = "platform_ops_competition_cancelled";
const PROOF_VOIDED_EVENT = "platform_ops_payment_proof_voided";

export type OpsPaymentErrorCode =
  | "ops_reason_required"
  | "ops_competition_not_found"
  | "ops_competition_not_published"
  | "ops_competition_payment_in_flight"
  | "ops_competition_concurrently_modified";

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
      "Tindakan operator yang mengesampingkan perlindungan peserta harus menyertakan alasan",
    );
  }

  return trimmed;
};

export type OpsCancelCompetitionResult = {
  competitionId: string;
  cancelledRegistrationCount: number;
};

/**
 * Performs the unpublish-as-cancellation on an organiser's behalf. The SAME terminal outcome as
 * `unpublishCompetition`, made by an accountable operator: the competition returns to draft, every
 * non-cancelled registration is cancelled, the search index drops it, every registration is marked
 * as made in a publication that has ended, every team is disbanded and the participants are told.
 * Refused, as the organiser's unpublish is (DEC-0132), while any transfer on the competition awaits
 * verification or was verified.
 *
 * Taking the competition down is the point. Cancelling only the registrations would leave the
 * competition live and publicly registerable while everyone already in it had been removed, so a
 * candidate could join a competition that had just been cancelled out from under its own entrants.
 *
 * Holds the participation lock and CASes on `status = 'published'` for the same reason the sibling
 * paths do: a concurrent participation decision or organiser transition must not interleave with a
 * cascade that cancels every registration. Irreversible: cancelled registrations are terminal
 * (DEC-0070) and nothing here can put them back.
 *
 * Never clears a proof. Voiding one is a separate, separately audited decision
 * (`voidPaymentProofAsOps`), so one click never both cancels a competition and discards the evidence
 * that someone paid for it.
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

  const result = await db.transaction(async (tx) => {
    const actor = await resolvePlatformOpsActor(tx, actorUserId);

    await acquireCompetitionParticipationLock(tx, competitionId);

    const [competition] = await tx
      .select({
        id: competitions.id,
        institutionId: competitions.institutionId,
        status: competitions.status,
      })
      .from(competitions)
      .where(eq(competitions.id, competitionId))
      .limit(1);

    if (!competition) {
      throw new OpsPaymentError("ops_competition_not_found", "Kompetisi tidak ditemukan", 404);
    }

    await assertOperatorHasNoInstitutionRelationship(
      tx,
      actor,
      competition.institutionId,
      OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
    );

    if (competition.status !== "published") {
      throw new OpsPaymentError(
        "ops_competition_not_published",
        `Cannot cancel a competition in '${competition.status}' status. Only a published competition can be cancelled`,
      );
    }

    // DEC-0132: refused while any transfer on the competition awaits verification or was verified,
    // as the organiser's unpublish is.
    if (await hasCompetitionPaymentInFlight(competitionId, tx)) {
      throw new OpsPaymentError(
        "ops_competition_payment_in_flight",
        "Kompetisi tidak dapat dibatalkan selama masih ada bukti transfer yang menunggu verifikasi atau sudah diverifikasi. Selesaikan dulu setiap bukti yang menunggu: penyelenggara memverifikasi atau menolaknya, atau Anda membatalkan bukti itu. Kompetisi dengan transfer yang sudah diverifikasi tidak dapat dibatalkan.",
        409,
      );
    }

    const [statusRow] = await tx
      .update(competitions)
      .set({ status: "draft", updatedAt: now })
      .where(and(eq(competitions.id, competitionId), eq(competitions.status, "published")))
      .returning({ id: competitions.id });

    if (!statusRow) {
      throw new OpsPaymentError(
        "ops_competition_concurrently_modified",
        "Status kompetisi berubah bersamaan, muat ulang lalu coba batalkan lagi",
        409,
      );
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

    await markCompetitionRegistrationsPublicationClosed(competitionId, now, tx);
    const disbandedTeamIds = await disbandEveryTeamOfCompetition(competitionId, now, tx);

    await recordOperatorAuditEntry(tx, actor, {
      // A competition is not a user, and the audit table's target_present_chk requires a user or an
      // institution. The owning institution is the accountable party here, so it is the target.
      targetInstitutionId: competition.institutionId,
      eventType: COMPETITION_CANCELLED_EVENT,
      reason: auditReason,
      metadata: {
        competitionId,
        cancelledRegistrationCount: cancelledRows.length,
        disbandedTeamCount: disbandedTeamIds.length,
      },
    });

    return { competitionId, cancelledRegistrationCount: cancelledRows.length };
  });

  logger.info("competition.cancelled.platform-ops", {
    competitionId,
    actorUserId,
    cancelledRegistrations: result.cancelledRegistrationCount,
  });

  // Fire-and-forget post-commit dispatch, matching the sibling cancel paths: neither enqueue
  // failure may fail a cancellation that has already committed.
  enqueueCompetitionSearchSync({ competitionId, action: "remove" }).catch((error) => {
    logger.error("competition.search-sync.enqueue-failed", {
      competitionId,
      action: "remove",
      error: error instanceof Error ? error.message : String(error),
    });
  });
  enqueueCompetitionCancelled({ competitionId, epoch: now.getTime() }).catch((error) => {
    logger.warn("competition.cancelled.enqueue-failed", {
      competitionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return result;
};

/**
 * Voids a bukti transfer that no organiser will act on again: one awaiting review, or one they
 * rejected and barred from resubmission.
 *
 * TWO POPULATIONS, ONE ACTION. Voiding a pending proof releases the DEC-0132 unpublish block that is
 * holding a competition open. Voiding a rejected-and-barred one releases a PERSON: the payer has no
 * resubmission, no cancel affordance and no organiser control left, and this is the only route back.
 * A verified proof stays out of reach in both cases, because the service's CAS refuses it.
 *
 * NO FINANCE EVENT IS WRITTEN, and this is the property that makes the action safe to expose.
 * Nothing was confirmed received, so there is nothing to record as succeeded, failed or refunded;
 * writing any event would put a claim about a payer's money into an append-only ledger that nobody
 * is in a position to make.
 */
export const voidPaymentProofAsOps = async (
  actorUserId: string,
  proofId: string,
  reason: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<FinanceManualPaymentProofRecord> => {
  const auditReason = requireReason(reason);

  const { proof: voided, recipientUserIds } = await db.transaction(async (tx) => {
    const actor = await resolvePlatformOpsActor(tx, actorUserId);

    // A proof that does not exist has no parties to refuse: voidManualPaymentProof raises its own
    // not-found below.
    const [parties] = await tx
      .select({
        payerUserId: financePayments.payerUserId,
        receivingInstitutionId: financePayments.receivingInstitutionId,
      })
      .from(financeManualPaymentProofs)
      .innerJoin(financePayments, eq(financePayments.id, financeManualPaymentProofs.paymentId))
      .where(eq(financeManualPaymentProofs.id, proofId))
      .limit(1);

    if (parties) {
      assertOperatorIsNotPayer(actor, parties.payerUserId);
      await assertOperatorHasNoInstitutionRelationship(
        tx,
        actor,
        parties.receivingInstitutionId,
        OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
      );
    }

    const proof = await voidManualPaymentProof(actor.userId, proofId, auditReason, tx, now);

    const [competition] = await tx
      .select({ institutionId: competitions.institutionId })
      .from(competitions)
      .where(eq(competitions.id, proof.competitionId))
      .limit(1);

    await recordOperatorAuditEntry(tx, actor, {
      // Falls back to the actor when the competition somehow cannot be read, so the audit row is
      // still written: losing the audit trail is a worse outcome than an imprecise target, and the
      // metadata below carries the precise subject either way.
      targetUserId: competition ? undefined : actor.userId,
      targetInstitutionId: competition?.institutionId,
      eventType: PROOF_VOIDED_EVENT,
      reason: auditReason,
      metadata: {
        proofId: proof.id,
        paymentId: proof.paymentId,
        competitionId: proof.competitionId,
        attempt: proof.resubmissionCount,
      },
    });

    const recipientUserIds = await resolveActivePaymentGroupMemberUserIdsByPaymentId(
      proof.paymentId,
      tx,
    );

    return { proof, recipientUserIds };
  });

  // AFTER the commit, like every other dispatch in this lane. The payer has to be told: their proof
  // has left `pending_review` without a verdict, and nothing else on their panel explains why. The
  // reason travels because an unexplained void is indistinguishable from the platform losing their
  // evidence.
  await notifyPaymentOutcome(
    voided.paymentId,
    "voided",
    { rejectionReason: auditReason, recipientUserIds },
    db,
  );

  return voided;
};

export { ManualProofError };
