// Field-bucket classification for post-publish competition edits.
//
// A published competition may be edited in place, but each changed field is classified by its
// impact on existing non-cancelled registrations:
//
//   blocked — the change would invalidate at least one existing non-cancelled registration; the
//             edit is refused (422 competition_post_publish_blocked) before any DB write.
//   notify  — the change is allowed but is participant-relevant; persisting it fans out a
//             competition.edited dual-channel notification.
//   trivial — copy-only change with no participant impact; persisted silently.
//
// This module is a PURE function over (oldRow, mergedRow, registration snapshot, now). The caller
// (updateCompetition service) decides what to do per bucket. It has no DB or server-only imports
// so it can be unit-tested directly.
//
// Relationship to IMMUTABLE_AFTER_PUBLISH: mode / minTeamSize / maxTeamSize are
// hard-immutable on a published competition and are rejected by the service's outer immutability
// layer BEFORE this classifier runs. Their handling below is retained for completeness and direct
// unit testing, but in the live edit path those fields never reach the classifier. Loosening
// IMMUTABLE_AFTER_PUBLISH to let the data-aware rules here govern mode/size widening is a controller
// decision, not assumed here.

import type { CompetitionCategory, CompetitionMode } from "@/server/db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

// The subset of competition fields this classifier reasons about. feeAmount is optional because
// it is API-blocked on the edit path (DEC-0022) and the public projection omits it; when omitted
// on either side it is simply not classified.
export type ClassifiableCompetition = {
  title: string;
  slug: string;
  description: string;
  category: CompetitionCategory | null;
  mode: CompetitionMode | null;
  minTeamSize: number | null;
  maxTeamSize: number | null;
  registrationStartAt: Date | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  eventEndAt: Date | null;
  resultAnnouncementAt: Date | null;
  allowCancellation: boolean;
  cancellationCutoffDays: number | null;
  feeAmount?: string | number | null;
};

// Snapshot of the competition's non-cancelled registrations at edit time. activeTeamSizes holds
// the current active-member count of each active team (one entry per team).
export type EditClassificationSnapshot = {
  nonCancelledCount: number;
  hasActiveIndividual: boolean;
  hasActiveTeam: boolean;
  activeTeamSizes: number[];
  hasActiveFree: boolean;
};

export type EditClassification = {
  blocked: string[];
  notify: string[];
  trivial: string[];
};

const timeOf = (value: Date | null): number | null => (value ? value.getTime() : null);

const feeToNumber = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

// Returns true when changing mode from `from` to `to` would strand at least one existing
// non-cancelled registration of the now-unsupported kind.
const isInvalidatingModeChange = (
  from: CompetitionMode | null,
  to: CompetitionMode | null,
  snapshot: EditClassificationSnapshot,
): boolean => {
  if (from === "both" && to === "team") return snapshot.hasActiveIndividual;
  if (from === "both" && to === "individual") return snapshot.hasActiveTeam;
  if (from === "team" && to === "individual") return snapshot.hasActiveTeam;
  if (from === "individual" && to === "team") return snapshot.hasActiveIndividual;
  // individual→both and team→both are widenings; they strand nobody.
  return false;
};

export const classifyCompetitionEdit = (
  oldRow: ClassifiableCompetition,
  newRow: ClassifiableCompetition,
  snapshot: EditClassificationSnapshot,
  now: Date = new Date(),
): EditClassification => {
  const blocked: string[] = [];
  const notify: string[] = [];
  const trivial: string[] = [];

  // mode
  if (oldRow.mode !== newRow.mode) {
    if (isInvalidatingModeChange(oldRow.mode, newRow.mode, snapshot)) {
      blocked.push("mode");
    } else {
      notify.push("mode");
    }
  }

  // minTeamSize — raising the floor above an existing team's current size strands that team.
  if (oldRow.minTeamSize !== newRow.minTeamSize) {
    const newMin = newRow.minTeamSize;
    if (newMin != null && snapshot.activeTeamSizes.some((size) => newMin > size)) {
      blocked.push("minTeamSize");
    } else {
      notify.push("minTeamSize");
    }
  }

  // maxTeamSize — lowering the cap below an existing team's current size strands that team.
  if (oldRow.maxTeamSize !== newRow.maxTeamSize) {
    const newMax = newRow.maxTeamSize;
    if (newMax != null && snapshot.activeTeamSizes.some((size) => newMax < size)) {
      blocked.push("maxTeamSize");
    } else {
      notify.push("maxTeamSize");
    }
  }

  // feeAmount — turning a free competition into a paid one while free registrations exist would
  // strand those registrations (paid flow is Phase 7). Only classified when fee is supplied.
  if (oldRow.feeAmount !== undefined && newRow.feeAmount !== undefined) {
    const oldFee = feeToNumber(oldRow.feeAmount);
    const newFee = feeToNumber(newRow.feeAmount);
    if (oldFee !== newFee) {
      if (oldFee === 0 && newFee > 0 && snapshot.hasActiveFree) {
        blocked.push("feeAmount");
      } else {
        notify.push("feeAmount");
      }
    }
  }

  // eventStartAt — once the event has begun, when it began is a fact rather than a field. Two
  // things measure from it: the participant-facing lifecycle phase, and the rule that a started
  // competition with registrants can no longer be withdrawn. Leaving the date editable would let
  // an organizer push the start into the future purely to reopen withdrawal and cancel everyone.
  // The same reasoning already protects eventEndAt's presence, which the results window and the
  // document-retention purge are measured from.
  if (timeOf(oldRow.eventStartAt) !== timeOf(newRow.eventStartAt)) {
    const startHasPassed =
      oldRow.eventStartAt != null && oldRow.eventStartAt.getTime() <= now.getTime();
    const movedEarlier =
      oldRow.eventStartAt != null &&
      newRow.eventStartAt != null &&
      newRow.eventStartAt.getTime() < oldRow.eventStartAt.getTime();
    const cutoff = newRow.cancellationCutoffDays;
    // Moving the event earlier so the cancellation cutoff lands in the past would retroactively
    // strip the right-to-cancel window from existing registrations.
    const retroactivelyClosesWindow =
      movedEarlier &&
      newRow.allowCancellation === true &&
      cutoff != null &&
      snapshot.nonCancelledCount > 0 &&
      newRow.eventStartAt!.getTime() - cutoff * DAY_MS <= now.getTime();

    if (startHasPassed || retroactivelyClosesWindow) {
      blocked.push("eventStartAt");
    } else {
      notify.push("eventStartAt");
    }
  }

  // Remaining schedule fields — always notify-worthy when changed.
  if (timeOf(oldRow.eventEndAt) !== timeOf(newRow.eventEndAt)) notify.push("eventEndAt");
  if (timeOf(oldRow.registrationStartAt) !== timeOf(newRow.registrationStartAt))
    notify.push("registrationStartAt");
  if (timeOf(oldRow.registrationEndAt) !== timeOf(newRow.registrationEndAt))
    notify.push("registrationEndAt");
  // Moving the promised results date is exactly what a waiting participant needs to hear about.
  if (timeOf(oldRow.resultAnnouncementAt) !== timeOf(newRow.resultAnnouncementAt))
    notify.push("resultAnnouncementAt");

  // Participant-relevant scalar fields.
  if (oldRow.title !== newRow.title) notify.push("title");
  if (oldRow.slug !== newRow.slug) notify.push("slug");
  if (oldRow.category !== newRow.category) notify.push("category");
  if (oldRow.allowCancellation !== newRow.allowCancellation) notify.push("allowCancellation");
  if (oldRow.cancellationCutoffDays !== newRow.cancellationCutoffDays)
    notify.push("cancellationCutoffDays");

  // Copy-only field — no participant impact.
  if (oldRow.description !== newRow.description) trivial.push("description");

  return { blocked, notify, trivial };
};
