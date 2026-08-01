import { describe, expect, it } from "vitest";
import { validateCompetitionTimeline } from "./competition-timeline";

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
