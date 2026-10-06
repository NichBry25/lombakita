import { describe, expect, it } from "vitest";
import { isRegistrationEndPast, validateCompetitionTimeline } from "./competition-timeline";

const chronologicalTimeline = () => ({
  registrationStartAt: "2026-08-01T09:00",
  registrationEndAt: "2026-08-10T09:00",
  participantConfirmationAt: "2026-08-10T09:00",
  eventStartAt: "2026-08-15T09:00",
  eventEndAt: "2026-08-16T17:00",
  resultAnnouncementAt: "2026-08-16T17:00",
});

describe("validateCompetitionTimeline", () => {
  it("accepts the complete chronological sequence", () => {
    expect(validateCompetitionTimeline(chronologicalTimeline())).toEqual([]);
  });

  it("rejects every reversed adjacent timeline boundary", () => {
    const errors = validateCompetitionTimeline({
      registrationStartAt: "2026-08-10T09:00",
      registrationEndAt: "2026-08-09T09:00",
      participantConfirmationAt: "2026-08-08T09:00",
      eventStartAt: "2026-08-07T09:00",
      eventEndAt: "2026-08-06T09:00",
      resultAnnouncementAt: "2026-08-05T09:00",
    });

    expect(errors.map(({ field }) => field)).toEqual(
      expect.arrayContaining([
        "registrationEndAt",
        "participantConfirmationAt",
        "eventStartAt",
        "eventEndAt",
        "resultAnnouncementAt",
      ]),
    );
  });

  it("requires strictly later start/end boundaries", () => {
    const errors = validateCompetitionTimeline({
      ...chronologicalTimeline(),
      registrationEndAt: "2026-08-01T09:00",
      eventEndAt: "2026-08-15T09:00",
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "registrationEndAt" }),
        expect.objectContaining({ field: "eventEndAt" }),
      ]),
    );
  });
});

describe("isRegistrationEndPast", () => {
  const end = new Date("2026-08-10T09:00:00.000Z");
  const endMs = end.getTime();

  it("is true one millisecond after the end", () => {
    expect(isRegistrationEndPast(end, endMs + 1)).toBe(true);
  });

  // The publish checklist refuses at `registrationEndAt <= now` (competition-core.ts), so the
  // instant the window ends is already past. `competition-core.test.ts` pins the two together.
  it("is true exactly at the end", () => {
    expect(isRegistrationEndPast(end, endMs)).toBe(true);
  });

  it("is false one millisecond before the end", () => {
    expect(isRegistrationEndPast(end, endMs - 1)).toBe(false);
  });

  it("reads an ISO string the same way as a Date", () => {
    expect(isRegistrationEndPast(end.toISOString(), endMs)).toBe(true);
    expect(isRegistrationEndPast(end.toISOString(), endMs - 1)).toBe(false);
  });

  it("is false for a string that is not a date", () => {
    expect(isRegistrationEndPast("not-a-date", endMs + 1)).toBe(false);
  });

  it("is false when there is no end date", () => {
    expect(isRegistrationEndPast(null, endMs + 1)).toBe(false);
    expect(isRegistrationEndPast(undefined, endMs + 1)).toBe(false);
    expect(isRegistrationEndPast("", endMs + 1)).toBe(false);
  });
});
