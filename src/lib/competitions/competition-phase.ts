// How far along a competition is, derived from its dates and whether its results have been
// published. Nothing here is stored: a phase computed from the clock cannot drift from the clock,
// so no scheduled job is needed to keep a column honest and the value is correct the moment it is
// read.
//
// This is a DISPLAY axis and gates nothing. Registration is already closed by its own deadline,
// and access decisions read `competitions.status` plus the registration dates as they always have.
// Nothing may start authorizing on a phase, or the app acquires a second lifecycle competing with
// the real one.
//
// Client-safe: pure, no server-only imports, so the public listing card and the server-rendered
// detail page derive the same phase from the same function.

export type CompetitionPhase =
  | "cancelled"
  | "upcoming"
  | "registration_open"
  | "registration_closing"
  | "registration_closed"
  | "in_progress"
  | "awaiting_results"
  | "results_overdue"
  | "results_announced";

// A deadline inside this window reads as "closing soon", matching the brand book's status-badge
// rule and the seven-day window the competition card already used.
const CLOSING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

// How long after the promised announcement date a competition keeps reading as simply "awaiting
// results". Judging runs late for ordinary reasons, and an organizer who is a few days over should
// not be presented as delinquent. Past this window the phase says the results have not arrived —
// neutrally, with no elapsed-time counter.
export const RESULT_ANNOUNCEMENT_GRACE_DAYS = 7;

// How long after the event a competition is assumed to owe results when the organizer named no
// date. Without this an organizer who simply leaves the field blank is never accountable, since
// there would be nothing for the grace window above to run from.
//
// Deliberately a SEPARATE constant from the grace window even though both are currently 7: one
// says when results become due, the other says how much lateness passes without comment. They
// answer different questions and either can move without the other.
export const DEFAULT_RESULT_ANNOUNCEMENT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CompetitionPhaseInput = {
  cancelledAt?: Date | string | null;
  registrationStartAt: Date | string | null;
  registrationEndAt: Date | string | null;
  eventStartAt: Date | string | null;
  eventEndAt: Date | string | null;
  resultAnnouncementAt: Date | string | null;
  // True when at least one published result exists for the competition. Only the existence of a
  // published result is needed here, never its contents.
  hasPublishedResult: boolean;
};

const toTime = (value: Date | string | null): number | null => {
  if (value === null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

// When results are due, and whether the organizer said so themselves.
//
//   declared — the organizer named the date; it is a commitment and may be presented as one.
//   derived  — nobody named a date, so it falls DEFAULT_RESULT_ANNOUNCEMENT_DAYS after the event.
//              Present this as an estimate: the organizer never promised it, and describing it as
//              a promise would hold them to words they did not write.
//   none     — the competition has no event end date either, so nothing can be inferred. The
//              phase can then never become overdue. Consistent with the retention purge, which
//              likewise skips a competition with no event_end_at rather than inventing one.
export type ResultAnnouncementSource = "declared" | "derived" | "none";

export type ResolvedResultAnnouncement = {
  at: Date | null;
  source: ResultAnnouncementSource;
};

export const resolveResultAnnouncement = (input: {
  resultAnnouncementAt: Date | string | null;
  eventEndAt: Date | string | null;
}): ResolvedResultAnnouncement => {
  const declared = toTime(input.resultAnnouncementAt);
  if (declared !== null) return { at: new Date(declared), source: "declared" };

  const eventEnd = toTime(input.eventEndAt);
  if (eventEnd === null) return { at: null, source: "none" };

  return {
    at: new Date(eventEnd + DEFAULT_RESULT_ANNOUNCEMENT_DAYS * DAY_MS),
    source: "derived",
  };
};

// Phases are resolved from the most advanced backwards, because each later phase is defined by a
// boundary the earlier ones have already passed. Every date on a competition is nullable, so each
// step falls through when the date it needs is absent rather than assuming a default.
export const deriveCompetitionPhase = (
  input: CompetitionPhaseInput,
  now: Date = new Date(),
): CompetitionPhase => {
  const currentTime = now.getTime();

  if (toTime(input.cancelledAt ?? null) !== null) return "cancelled";
  if (input.hasPublishedResult) return "results_announced";

  const eventEnd = toTime(input.eventEndAt);
  if (eventEnd !== null && currentTime > eventEnd) {
    // Runs against the resolved date, so a competition whose organizer named no date still
    // becomes overdue rather than sitting in "awaiting results" indefinitely.
    const announcement = resolveResultAnnouncement(input).at;
    if (
      announcement !== null &&
      currentTime > announcement.getTime() + RESULT_ANNOUNCEMENT_GRACE_DAYS * DAY_MS
    ) {
      return "results_overdue";
    }
    return "awaiting_results";
  }

  const eventStart = toTime(input.eventStartAt);
  if (eventStart !== null && currentTime >= eventStart) return "in_progress";

  const registrationEnd = toTime(input.registrationEndAt);
  if (registrationEnd !== null && currentTime > registrationEnd) return "registration_closed";

  const registrationStart = toTime(input.registrationStartAt);
  if (registrationStart !== null && currentTime < registrationStart) return "upcoming";

  if (registrationEnd !== null && registrationEnd - currentTime < CLOSING_SOON_MS) {
    return "registration_closing";
  }

  return "registration_open";
};

const PHASE_LABELS: Record<CompetitionPhase, string> = {
  cancelled: "Dibatalkan",
  upcoming: "Akan dibuka",
  registration_open: "Pendaftaran dibuka",
  registration_closing: "Segera ditutup",
  registration_closed: "Pendaftaran ditutup",
  in_progress: "Sedang berlangsung",
  awaiting_results: "Menunggu hasil",
  results_overdue: "Hasil belum diumumkan",
  results_announced: "Hasil diumumkan",
};

// Maps onto the `data-status` values the shared .status-badge styles already implement, so every
// phase renders as a tinted pill with its own dot and never depends on colour alone.
const PHASE_BADGE_STATUS: Record<CompetitionPhase, string> = {
  cancelled: "cancelled",
  upcoming: "upcoming",
  registration_open: "open",
  registration_closing: "closing",
  registration_closed: "closed",
  in_progress: "ongoing",
  awaiting_results: "awaiting",
  results_overdue: "overdue",
  results_announced: "announced",
};

export const getCompetitionPhaseLabel = (phase: CompetitionPhase): string => PHASE_LABELS[phase];

export const getCompetitionPhaseBadgeStatus = (phase: CompetitionPhase): string =>
  PHASE_BADGE_STATUS[phase];

export const isAwaitingResultsPhase = (phase: CompetitionPhase): boolean =>
  phase === "awaiting_results" || phase === "results_overdue";
