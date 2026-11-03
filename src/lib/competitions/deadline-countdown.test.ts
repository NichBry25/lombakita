import { describe, expect, it } from "vitest";
import { describeDeadlineCountdown, describeRegistrationCountdown } from "./deadline-countdown";

const NOW = new Date("2026-10-30T03:00:00.000Z");
const hoursFromNow = (hours: number) => new Date(NOW.getTime() + hours * 60 * 60 * 1000);

describe("describeDeadlineCountdown", () => {
  it("has nothing to count down to without a deadline", () => {
    expect(describeDeadlineCountdown(null, NOW)).toBeNull();
  });

  it("ignores a value that is not a date", () => {
    expect(describeDeadlineCountdown("not a date", NOW)).toBeNull();
  });

  it("says registration is closed once the deadline has passed", () => {
    expect(describeDeadlineCountdown(hoursFromNow(-1), NOW)).toEqual({
      label: "Pendaftaran ditutup",
      tone: "closed",
    });
    expect(describeDeadlineCountdown(NOW, NOW)?.tone).toBe("closed");
  });

  it("calls the final 24 hours the last day", () => {
    expect(describeDeadlineCountdown(hoursFromNow(5), NOW)).toEqual({
      label: "Hari terakhir",
      tone: "closing",
    });
    expect(describeDeadlineCountdown(hoursFromNow(24), NOW)?.label).toBe("Hari terakhir");
  });

  it("counts whole days left, rounding a part day up", () => {
    expect(describeDeadlineCountdown(hoursFromNow(25), NOW)?.label).toBe("Sisa 2 hari");
    expect(describeDeadlineCountdown(hoursFromNow(72), NOW)?.label).toBe("Sisa 3 hari");
  });

  it("marks the last week as closing and the week before it as open", () => {
    expect(describeDeadlineCountdown(hoursFromNow(7 * 24), NOW)?.tone).toBe("closing");
    expect(describeDeadlineCountdown(hoursFromNow(7 * 24 + 1), NOW)).toEqual({
      label: "Sisa 8 hari",
      tone: "open",
    });
    expect(describeDeadlineCountdown(hoursFromNow(14 * 24), NOW)?.label).toBe("Sisa 14 hari");
  });

  it("shows the date past the countdown window, with the year only when it differs", () => {
    expect(describeDeadlineCountdown("2026-12-01T05:00:00.000Z", NOW)).toEqual({
      label: "Tutup 1 Des",
      tone: "open",
    });
    expect(describeDeadlineCountdown("2027-02-01T05:00:00.000Z", NOW)?.label).toBe(
      "Tutup 1 Feb 2027",
    );
  });
});

describe("describeRegistrationCountdown", () => {
  it("shows the opening date while registration has not opened", () => {
    expect(
      describeRegistrationCountdown("2026-11-03T05:00:00.000Z", hoursFromNow(30 * 24), NOW),
    ).toEqual({ label: "Buka 3 Nov", tone: "upcoming" });
  });

  it("counts down to the deadline once registration is open", () => {
    expect(describeRegistrationCountdown(hoursFromNow(-48), hoursFromNow(72), NOW)?.label).toBe(
      "Sisa 3 hari",
    );
    expect(describeRegistrationCountdown(null, hoursFromNow(72), NOW)?.label).toBe("Sisa 3 hari");
  });
});
