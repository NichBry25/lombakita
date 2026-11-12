// A registration deadline as the short phrase a reader acts on: "Sisa 3 hari" says more at a glance
// than "12 Nov 2026", and it is the phrase that brings a saved competition back to mind before it
// closes. Shared by the homepage rows and the saved list, so both count down the same way.
//
// Days are counted from the remaining hours rather than from calendar dates, so the phrase does not
// depend on the time zone of whoever renders it (the server renders in UTC, readers sit in WIB, WITA
// and WIT).

const DAY_MS = 24 * 60 * 60 * 1000;

// Past this many days a countdown stops being urgent and the date itself is clearer.
export const COUNTDOWN_WINDOW_DAYS = 14;

// Matches the "closing" badge window used by the listing filter and the competition card.
const CLOSING_WINDOW_DAYS = 7;

// Values of `.status-badge[data-status]`, so the chip reuses the existing status colours.
export type DeadlineCountdownTone = "upcoming" | "open" | "closing" | "closed";

export type DeadlineCountdown = {
  label: string;
  tone: DeadlineCountdownTone;
};

const formatShortDate = (date: Date, now: Date): string =>
  date.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    // The year only earns its space when it is not this year.
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });

// Null when there is no deadline: an always-open competition has nothing to count down to.
export function describeDeadlineCountdown(
  registrationEndAt: Date | string | null,
  now: Date = new Date(),
): DeadlineCountdown | null {
  if (!registrationEndAt) return null;

  const deadline = new Date(registrationEndAt);
  const remainingMs = deadline.getTime() - now.getTime();

  if (Number.isNaN(remainingMs)) return null;
  if (remainingMs <= 0) return { label: "Pendaftaran ditutup", tone: "closed" };

  const daysLeft = Math.ceil(remainingMs / DAY_MS);
  if (daysLeft === 1) return { label: "Hari terakhir", tone: "closing" };
  if (daysLeft <= COUNTDOWN_WINDOW_DAYS) {
    return {
      label: `Sisa ${daysLeft} hari`,
      tone: daysLeft <= CLOSING_WINDOW_DAYS ? "closing" : "open",
    };
  }

  return { label: `Tutup ${formatShortDate(deadline, now)}`, tone: "open" };
}

// The same, for a competition whose registration may not have opened yet: until it opens, the date
// it opens is the one that matters.
export function describeRegistrationCountdown(
  registrationStartAt: Date | string | null,
  registrationEndAt: Date | string | null,
  now: Date = new Date(),
): DeadlineCountdown | null {
  const opensAt = registrationStartAt ? new Date(registrationStartAt) : null;
  if (opensAt && opensAt.getTime() > now.getTime()) {
    return { label: `Buka ${formatShortDate(opensAt, now)}`, tone: "upcoming" };
  }
  return describeDeadlineCountdown(registrationEndAt, now);
}
