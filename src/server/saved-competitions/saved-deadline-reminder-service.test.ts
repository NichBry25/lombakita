// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/server/competitions/competition-public-service", () => ({
  buildPublicVisibilityCondition: () => sql`true`,
}));

import {
  listDueSavedDeadlineReminders,
  reminderDaysBefore,
  resolveReminderAnchor,
  sweepSavedDeadlineReminders,
} from "./saved-deadline-reminder-service";
import type { Database } from "@/server/db/client";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// 09:00 WIB on 3 Nov 2026.
const ANCHOR = new Date("2026-11-03T02:00:00.000Z");

// A query builder that accepts any chain of calls and resolves to `rows` when awaited. The SQL
// itself is checked against a real database by hand (see HANDOFF.md); these tests are about what
// the service does with the rows it gets back.
const fakeDb = (rows: unknown[]): Database => {
  const chain: unknown = new Proxy(() => undefined, {
    get: (_target, property) =>
      property === "then" ? (resolve: (value: unknown[]) => void) => resolve(rows) : () => chain,
  });
  return chain as Database;
};

const row = (userId: string, competitionId: string, deadline: Date) => ({
  userId,
  competitionId,
  competitionSlug: `slug-${competitionId}`,
  competitionTitle: `Kompetisi ${competitionId}`,
  institutionSlug: "himpunan",
  registrationEndAt: deadline,
});

afterEach(() => vi.clearAllMocks());

describe("resolveReminderAnchor", () => {
  it("is 09:00 WIB the same day once that moment has passed", () => {
    expect(resolveReminderAnchor(new Date("2026-11-03T02:00:00.000Z"))).toEqual(ANCHOR);
    expect(resolveReminderAnchor(new Date("2026-11-03T15:30:00.000Z"))).toEqual(ANCHOR);
  });

  it("is the previous day's 09:00 WIB before that moment", () => {
    expect(resolveReminderAnchor(new Date("2026-11-03T01:59:59.000Z"))).toEqual(
      new Date("2026-11-02T02:00:00.000Z"),
    );
  });

  it("crosses a month boundary", () => {
    expect(resolveReminderAnchor(new Date("2026-12-01T00:30:00.000Z"))).toEqual(
      new Date("2026-11-30T02:00:00.000Z"),
    );
  });
});

describe("reminderDaysBefore", () => {
  const at = (ms: number) => new Date(ANCHOR.getTime() + ms);

  it("matches each band, including a deadline exactly on its edge", () => {
    expect(reminderDaysBefore(at(7 * DAY), ANCHOR)).toBe(7);
    expect(reminderDaysBefore(at(6 * DAY + HOUR), ANCHOR)).toBe(7);
    expect(reminderDaysBefore(at(3 * DAY), ANCHOR)).toBe(3);
    expect(reminderDaysBefore(at(HOUR), ANCHOR)).toBe(1);
    expect(reminderDaysBefore(at(DAY), ANCHOR)).toBe(1);
  });

  it("skips the days between bands and anything already closed", () => {
    expect(reminderDaysBefore(at(DAY + HOUR), ANCHOR)).toBeNull();
    expect(reminderDaysBefore(at(5 * DAY), ANCHOR)).toBeNull();
    expect(reminderDaysBefore(at(7 * DAY + HOUR), ANCHOR)).toBeNull();
    expect(reminderDaysBefore(ANCHOR, ANCHOR)).toBeNull();
    expect(reminderDaysBefore(at(-HOUR), ANCHOR)).toBeNull();
  });

  // The property the whole design rests on: with one sweep a day, every deadline is due each
  // reminder exactly once, so nothing needs to remember what was sent.
  it("puts a deadline in each band on exactly one daily anchor", () => {
    const deadline = new Date("2026-11-20T16:59:00.000Z");
    const hits: Record<number, number> = {};
    for (let day = 0; day < 30; day += 1) {
      const anchor = new Date(ANCHOR.getTime() + day * DAY);
      const band = reminderDaysBefore(deadline, anchor);
      if (band !== null) hits[band] = (hits[band] ?? 0) + 1;
    }
    expect(hits).toEqual({ 7: 1, 3: 1, 1: 1 });
  });
});

describe("listDueSavedDeadlineReminders", () => {
  it("tags each row with its band and drops anything outside the bands", async () => {
    const db = fakeDb([
      row("user_a", "c1", new Date(ANCHOR.getTime() + 2 * HOUR)),
      row("user_a", "c2", new Date(ANCHOR.getTime() + 5 * DAY)),
      row("user_b", "c3", new Date(ANCHOR.getTime() + 3 * DAY)),
    ]);

    const due = await listDueSavedDeadlineReminders(ANCHOR, {}, db);

    expect(due.map((reminder) => [reminder.competitionId, reminder.daysBefore])).toEqual([
      ["c1", 1],
      ["c3", 3],
    ]);
  });
});

describe("sweepSavedDeadlineReminders", () => {
  it("enqueues one job per student, however many of their competitions are due", async () => {
    const db = fakeDb([
      row("user_a", "c1", new Date(ANCHOR.getTime() + 2 * HOUR)),
      row("user_a", "c2", new Date(ANCHOR.getTime() + 3 * DAY)),
      row("user_b", "c3", new Date(ANCHOR.getTime() + 7 * DAY)),
    ]);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const result = await sweepSavedDeadlineReminders({
      enqueue,
      db,
      now: new Date("2026-11-03T02:04:00.000Z"),
    });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith({ userId: "user_a", anchorAt: ANCHOR.toISOString() });
    expect(enqueue).toHaveBeenCalledWith({ userId: "user_b", anchorAt: ANCHOR.toISOString() });
    expect(result).toEqual({ anchorAt: ANCHOR, due: 3, students: 2, enqueued: 2, failed: 0 });
  });

  it("keeps going when one student's job cannot be enqueued, and counts it", async () => {
    const db = fakeDb([
      row("user_a", "c1", new Date(ANCHOR.getTime() + 2 * HOUR)),
      row("user_b", "c2", new Date(ANCHOR.getTime() + 2 * HOUR)),
    ]);
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce(undefined);

    const result = await sweepSavedDeadlineReminders({ enqueue, db, now: ANCHOR });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ students: 2, enqueued: 1, failed: 1 });
  });

  it("enqueues nothing when nothing is due", async () => {
    const enqueue = vi.fn();

    const result = await sweepSavedDeadlineReminders({ enqueue, db: fakeDb([]), now: ANCHOR });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ due: 0, students: 0, enqueued: 0, failed: 0 });
  });
});
