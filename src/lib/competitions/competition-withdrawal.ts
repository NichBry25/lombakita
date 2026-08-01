// Whether an organizer may still withdraw a published competition back to draft.
//
// Withdrawal is not a quiet visibility change: it cancels every non-cancelled registration in the
// same transaction, removes the competition from search and the public listing, and 404s its
// detail page. Doing that once the event is under way abandons participants mid-competition and
// strands them on a page that no longer exists — the harm DEC-0123 removed archiving to prevent.
//
// The condition is therefore two-part, and both halves matter:
//
//   the event has started  — the point past which participants are relying on the competition
//   AND someone is registered — because with nobody registered there is nobody to strand
//
// The second half is the escape hatch for the case that motivates the rule's existence: a
// competition published with wrong information and no takers can still be pulled, at any time.
// It mirrors Eventbrite, which permits unpublishing only while an event holds no completed
// orders. Wrong information on a competition people HAVE joined is corrected by editing it,
// which already notifies every registrant.
//
// Deliberately NOT derived from `deriveCompetitionPhase`. That module states it is a display axis
// that gates nothing, and routing an authorization decision through it would make the app grow a
// second lifecycle competing with `competitions.status`. This reads the inputs it needs directly.
//
// Client-safe: pure, no server-only imports, so the service gate and the organizer console derive
// the same answer from the same function.

import { isParticipantCancellationClosedByConfirmation } from "@/lib/competitions/competition-participation";

export type WithdrawalEligibilityInput = {
  eventStartAt: Date | string | null;
  participantConfirmationAt?: Date | string | null;
  // True when the competition holds at least one registration that is not cancelled.
  hasActiveRegistrations: boolean;
};

const toTime = (value: Date | string | null): number | null => {
  if (value === null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

// True from the moment the event starts. The boundary is inclusive: at exactly the start time the
// competition is under way.
//
// A competition with no start date has never started — nothing marks the point where withdrawal
// stops being safe. Unreachable for a published competition (the publish checklist requires the
// date, and it cannot be cleared afterwards), so this is a defensive fallback rather than a live
// branch.
export const hasCompetitionStarted = (
  eventStartAt: Date | string | null,
  now: Date = new Date(),
): boolean => {
  const start = toTime(eventStartAt);
  if (start === null) return false;
  return now.getTime() >= start;
};

export const canWithdrawPublication = (
  input: WithdrawalEligibilityInput,
  now: Date = new Date(),
): boolean => {
  if (isParticipantCancellationClosedByConfirmation(input.participantConfirmationAt ?? null, now)) {
    return false;
  }
  if (!hasCompetitionStarted(input.eventStartAt, now)) return true;
  return !input.hasActiveRegistrations;
};
