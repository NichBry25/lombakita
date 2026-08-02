// Pure utility for deriving upcoming deadlines from a candidate's registrations.
// No DB access, no server-only imports. Safe to import in server components and utilities.

export type UpcomingDeadline = {
  label: "registration_closes" | "event_starts";
  date: Date;
  competitionTitle: string;
};

type RegistrationWithDates = {
  registrationStatus: string;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  competitionTitle: string;
};

// Collects upcoming deadline dates from non-cancelled registrations.
// - Excludes cancelled registrations entirely.
// - Excludes dates that are not strictly in the future relative to `now`.
// - De-duplicates by label + date value (same date from two registrations → one entry).
// - Returns the nearest 3 deadlines sorted ascending.
export const deriveUpcomingDeadlines = (
  registrations: RegistrationWithDates[],
  now: Date = new Date(),
): UpcomingDeadline[] => {
  const candidates: UpcomingDeadline[] = [];
  const seen = new Set<string>();

  for (const reg of registrations) {
    if (reg.registrationStatus === "cancelled") continue;

    const add = (label: UpcomingDeadline["label"], date: Date | null) => {
      if (!date || date.getTime() <= now.getTime()) return;
      const key = `${label}:${date.getTime()}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ label, date, competitionTitle: reg.competitionTitle });
    };

    add("registration_closes", reg.registrationEndAt);
    add("event_starts", reg.eventStartAt);
  }

  return candidates.sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, 3);
};
