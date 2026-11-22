import type { CompetitionRegistrationStatus } from "@/server/db/schema";
import { INSTITUTION_CANCELLATION_REASON } from "@/server/competitions/competition-lifecycle";

/**
 * The cancellation reason written on an expired registration.
 *
 * A distinct sentinel rather than prose, because `cancellation_reason` is free text with no enum
 * and every later report has to separate "the candidate withdrew" from "the platform cancelled
 * this because nobody paid". Those are opposite facts about the same column, and a human-written
 * sentence cannot be filtered on reliably.
 */
export const PAYMENT_EXPIRY_CANCELLATION_REASON = "payment_deadline_expired";

/**
 * Whether the registration was cancelled by the person's own withdrawal.
 *
 * A withdrawal is the one cancellation whose reason is text the person typed and is never empty.
 * The platform writes named sentinels for its own cancellations, so a cancelled row with no
 * sentinel and a reason is the person's own. This function checks two of them. A third,
 * TEAM_BELOW_MINIMUM_CANCELLATION_REASON (team-close-check-service.ts), is written only for free
 * competitions today, which have no payment view.
 */
export const wasWithdrawnByCandidate = (registration: {
  status: CompetitionRegistrationStatus;
  cancellationReason: string | null;
}): boolean => {
  if (registration.status !== "cancelled") return false;
  if (registration.cancellationReason === null) return false;
  if (registration.cancellationReason === PAYMENT_EXPIRY_CANCELLATION_REASON) return false;
  return registration.cancellationReason !== INSTITUTION_CANCELLATION_REASON;
};
