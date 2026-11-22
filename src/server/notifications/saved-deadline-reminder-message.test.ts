// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  buildSavedDeadlineReminderEmail,
  buildSavedDeadlineReminderInbox,
  formatDeadlineWib,
  type SavedDeadlineReminderItem,
} from "./saved-deadline-reminder-message";

// 09:00 WIB on 3 Nov 2026.
const ANCHOR = new Date("2026-11-03T02:00:00.000Z");

const lastDay: SavedDeadlineReminderItem = {
  competitionTitle: "UI/UX Sprint: Aplikasi Layanan Publik",
  competitionSlug: "uiux-sprint",
  institutionSlug: "himpunan-informatika",
  // 23:59 WIB on 3 Nov.
  registrationEndAt: new Date("2026-11-03T16:59:00.000Z"),
};

const threeDays: SavedDeadlineReminderItem = {
  competitionTitle: "Business Case Challenge Nasional",
  competitionSlug: "business-case",
  institutionSlug: "himpunan-informatika",
  registrationEndAt: new Date("2026-11-06T01:00:00.000Z"),
};

describe("formatDeadlineWib", () => {
  it("shows the deadline in WIB, not the server's UTC", () => {
    const text = formatDeadlineWib(lastDay.registrationEndAt);
    expect(text).toMatch(/Selasa, 3 November/);
    expect(text).toMatch(/23[.:]59 WIB$/);
  });
});

describe("buildSavedDeadlineReminderEmail", () => {
  it("leads the subject with the countdown when one competition is due", () => {
    const { subject } = buildSavedDeadlineReminderEmail([lastDay], ANCHOR, "https://lombakita.com");
    expect(subject).toBe("Hari terakhir — UI/UX Sprint: Aplikasi Layanan Publik");
  });

  it("counts the competitions in the subject when several are due", () => {
    const { subject } = buildSavedDeadlineReminderEmail(
      [lastDay, threeDays],
      ANCHOR,
      "https://lombakita.com",
    );
    expect(subject).toBe("2 kompetisi tersimpanmu segera ditutup");
  });

  it("lists each competition with its countdown, deadline and link, then how to stop", () => {
    const { text } = buildSavedDeadlineReminderEmail(
      [lastDay, threeDays],
      ANCHOR,
      "https://lombakita.com",
    );

    expect(text).toContain("• UI/UX Sprint: Aplikasi Layanan Publik — Hari terakhir");
    expect(text).toContain("• Business Case Challenge Nasional — Sisa 3 hari");
    expect(text).toContain("https://lombakita.com/competitions/himpunan-informatika/uiux-sprint");
    expect(text).toContain("Pendaftaran ditutup Selasa, 3 November");
    expect(text).toContain("https://lombakita.com/saved");
  });
});

describe("buildSavedDeadlineReminderInbox", () => {
  it("names the competition in the title when one is due", () => {
    const { title, body } = buildSavedDeadlineReminderInbox([threeDays], ANCHOR);
    expect(title).toBe("Sisa 3 hari: Business Case Challenge Nasional");
    expect(body).toMatch(/^"Business Case Challenge Nasional": sisa 3 hari, ditutup /);
  });

  it("counts them in the title and lists each in the body when several are due", () => {
    const { title, body } = buildSavedDeadlineReminderInbox([lastDay, threeDays], ANCHOR);
    expect(title).toBe("2 kompetisi tersimpan segera ditutup");
    expect(body).toContain('"UI/UX Sprint: Aplikasi Layanan Publik": hari terakhir');
    expect(body).toContain('"Business Case Challenge Nasional": sisa 3 hari');
  });
});
