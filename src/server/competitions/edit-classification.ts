// Field-bucket classification for an edit to a published competition.
//
// Each changed field lands in one of three buckets:
//
//   blocked: the change makes things worse for someone already registered, so the edit is refused
//            (422 competition_post_publish_blocked) before any DB write.
//   waitsForTransferReview: the change is allowed once no transfer awaits verification, and until
//            then the edit is refused (409 competition_close_waits_for_transfer_review).
//   notify:  the change is allowed, and persisting it fans out a competition.edited notification.
//
// A field is blocked by what it is and which way it moved, never by who has registered so far, so
// the editor can show it locked before the host types and a registration landing during the edit
// cannot change the answer. Two rules also read the clock or money: once the event has begun its
// start is fixed and its end can only move later, and a later registration close waits while a
// transfer awaits verification.
//
// This module is a PURE function over (oldRow, mergedRow, registration snapshot, now). The callers
// (the published edit path, the fee path and the competition editor) decide what to do per bucket.
// It has no DB or server-only imports, so it is unit-tested directly and runs in the browser.
//
// mode is also in IMMUTABLE_AFTER_PUBLISH, which refuses it before this classifier runs on the edit
// path. It is blocked here as well, so this function names every field publishing locks.

import type { CompetitionCategory, CompetitionMode } from "@/server/db/schema";

// The subset of competition fields this classifier reasons about.
//
// EVERY FIELD IS REQUIRED, including the three pricing fields, and that is load-bearing rather than
// tidy. While they were optional a caller could omit them and every fee rule below silently
// classified nothing: no error, no failing test, a whole branch of this module unreachable. Making
// them required turns that omission into a compile error at the caller.
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
  // Integer smallest unit (@/lib/finance/money). NULL and 0 both mean free.
  feeAmount: number | null;
  feeCurrency: string | null;
  paymentWindowDays: number;
};

// Snapshot of the competition's non-cancelled registrations at edit time. activeTeamSizes holds
// the current active-member count of each active team (one entry per team).
export type EditClassificationSnapshot = {
  nonCancelledCount: number;
  hasActiveIndividual: boolean;
  hasActiveTeam: boolean;
  activeTeamSizes: number[];
  hasActiveFree: boolean;
  // Whether a bukti transfer awaits the organiser's verification anywhere on this competition
  // (hasCompetitionTransferAwaitingReview in server/finance/paid-registration.ts), passed in
  // rather than queried because this module is pure.
  hasTransferAwaitingReview: boolean;
};

export type EditClassification = {
  blocked: string[];
  // Allowed changes that must wait until no bukti transfer awaits verification.
  waitsForTransferReview: string[];
  notify: string[];
};

const timeOf = (value: Date | null): number | null => (value ? value.getTime() : null);

const feeToNumber = (value: number | null): number => value ?? 0;

// Lowered, raised and later hold only when both values are set. A value appearing or disappearing
// is none of them, so every rule below that allows one direction refuses it.
const isLowered = (from: number | null, to: number | null): boolean =>
  from !== null && to !== null && to < from;

const isRaised = (from: number | null, to: number | null): boolean =>
  from !== null && to !== null && to > from;

const isLater = (from: Date | null, to: Date | null): boolean =>
  from !== null && to !== null && to.getTime() > from.getTime();

const hasStarted = (row: ClassifiableCompetition, now: Date): boolean =>
  row.eventStartAt !== null && row.eventStartAt.getTime() <= now.getTime();

// A larger cutoff closes withdrawal more days before the event, which shortens the right to cancel.
// Turning withdrawal off altogether is the allowCancellation rule's to refuse.
const shortensCancellationWindow = (
  oldRow: ClassifiableCompetition,
  newRow: ClassifiableCompetition,
): boolean =>
  oldRow.allowCancellation &&
  newRow.allowCancellation &&
  !isLowered(oldRow.cancellationCutoffDays, newRow.cancellationCutoffDays);

export const classifyCompetitionEdit = (
  oldRow: ClassifiableCompetition,
  newRow: ClassifiableCompetition,
  snapshot: EditClassificationSnapshot,
  now: Date = new Date(),
): EditClassification => {
  const blocked: string[] = [];
  const waitsForTransferReview: string[] = [];
  const notify: string[] = [];

  if (oldRow.mode !== newRow.mode) blocked.push("mode");

  // A team that registered at the old minimum would fall short of a raised one.
  if (oldRow.minTeamSize !== newRow.minTeamSize) {
    if (isLowered(oldRow.minTeamSize, newRow.minTeamSize)) {
      notify.push("minTeamSize");
    } else {
      blocked.push("minTeamSize");
    }
  }

  // A team that registered at the old maximum would be over a lowered one.
  if (oldRow.maxTeamSize !== newRow.maxTeamSize) {
    if (isRaised(oldRow.maxTeamSize, newRow.maxTeamSize)) {
      notify.push("maxTeamSize");
    } else {
      blocked.push("maxTeamSize");
    }
  }

  // The price a candidate registered under is the price they owe, so neither the amount nor the
  // currency moves after publish, in either direction and whoever has registered. An amount
  // without its currency is not a price (@/lib/finance/money), so both halves are named.
  if (feeToNumber(oldRow.feeAmount) !== feeToNumber(newRow.feeAmount)) blocked.push("feeAmount");
  if (oldRow.feeCurrency !== newRow.feeCurrency) blocked.push("feeCurrency");

  // paymentWindowDays: NOTIFY, never blocked. Shortening the window cannot harm anyone already
  // paying: a deadline is snapshotted onto each payment at creation and never recomputed, so an
  // existing pending payment keeps the deadline it was given. It is participant-relevant for
  // everyone who registers AFTER the change, which is what notify is for.
  if (oldRow.paymentWindowDays !== newRow.paymentWindowDays) {
    notify.push("paymentWindowDays");
  }

  // eventStartAt: an earlier start takes preparation time away from everyone registered and pulls
  // the cancellation cutoff, which is counted back from it, earlier with it. Once the event has
  // begun, when it began is a fact rather than a field. Two things measure from it: the
  // participant-facing lifecycle phase, and the rule that a started competition with registrants
  // can no longer be withdrawn. Leaving the date editable would let an organizer push the start
  // into the future purely to reopen withdrawal and cancel everyone.
  if (timeOf(oldRow.eventStartAt) !== timeOf(newRow.eventStartAt)) {
    const startHasPassed = hasStarted(oldRow, now);
    if (startHasPassed || !isLater(oldRow.eventStartAt, newRow.eventStartAt)) {
      blocked.push("eventStartAt");
    } else {
      notify.push("eventStartAt");
    }
  }

  // eventEndAt: a later end only helps. An earlier end shortens the submission window, which runs
  // from the start to the end, so once the event has begun it is BLOCKED. Before the start it is
  // announced like any other schedule move.
  if (timeOf(oldRow.eventEndAt) !== timeOf(newRow.eventEndAt)) {
    if (hasStarted(oldRow, now) && !isLater(oldRow.eventEndAt, newRow.eventEndAt)) {
      blocked.push("eventEndAt");
    } else {
      notify.push("eventEndAt");
    }
  }
  // The registration start is announced whenever it moves.
  if (timeOf(oldRow.registrationStartAt) !== timeOf(newRow.registrationStartAt))
    notify.push("registrationStartAt");

  // registrationEndAt: an earlier close takes away time candidates were promised, so it is BLOCKED.
  // A later close WAITS while a transfer awaits verification: that payment's deadline was clamped
  // to the old close at creation and is never recomputed (@/lib/finance/payment-window), so the host
  // decides the transfer before the close moves past it. A verified transfer is settled and holds
  // nothing back.
  if (timeOf(oldRow.registrationEndAt) !== timeOf(newRow.registrationEndAt)) {
    if (!isLater(oldRow.registrationEndAt, newRow.registrationEndAt)) {
      blocked.push("registrationEndAt");
    } else if (snapshot.hasTransferAwaitingReview) {
      waitsForTransferReview.push("registrationEndAt");
    } else {
      notify.push("registrationEndAt");
    }
  }
  // Moving the promised results date is exactly what a waiting participant needs to hear about.
  if (timeOf(oldRow.resultAnnouncementAt) !== timeOf(newRow.resultAnnouncementAt))
    notify.push("resultAnnouncementAt");

  if (oldRow.title !== newRow.title) notify.push("title");
  // The slug is the competition's address, and every link already shared points at it.
  if (oldRow.slug !== newRow.slug) blocked.push("slug");
  if (oldRow.category !== newRow.category) notify.push("category");
  if (oldRow.description !== newRow.description) notify.push("description");

  // Granting the right to withdraw only helps. Taking it away strands everyone who registered
  // counting on it.
  if (oldRow.allowCancellation !== newRow.allowCancellation) {
    if (oldRow.allowCancellation) {
      blocked.push("allowCancellation");
    } else {
      notify.push("allowCancellation");
    }
  }
  if (oldRow.cancellationCutoffDays !== newRow.cancellationCutoffDays) {
    if (shortensCancellationWindow(oldRow, newRow)) {
      blocked.push("cancellationCutoffDays");
    } else {
      notify.push("cancellationCutoffDays");
    }
  }

  return { blocked, waitsForTransferReview, notify };
};
