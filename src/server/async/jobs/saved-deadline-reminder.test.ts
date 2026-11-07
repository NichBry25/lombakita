// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockFindReminderRecipientEmail,
  mockListDueSavedDeadlineReminders,
  mockSendSavedDeadlineReminderEmail,
  mockWriteInboxNotificationSafely,
} = vi.hoisted(() => ({
  mockFindReminderRecipientEmail: vi.fn(),
  mockListDueSavedDeadlineReminders: vi.fn(),
  mockSendSavedDeadlineReminderEmail: vi.fn(),
  mockWriteInboxNotificationSafely: vi.fn(),
}));

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/server/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/saved-competitions/saved-deadline-reminder-service", () => ({
  findReminderRecipientEmail: mockFindReminderRecipientEmail,
  listDueSavedDeadlineReminders: mockListDueSavedDeadlineReminders,
}));
vi.mock("@/server/notifications/notification-email", () => ({
  sendSavedDeadlineReminderEmail: mockSendSavedDeadlineReminderEmail,
}));
vi.mock("@/server/notifications/inbox-write", () => ({
  writeInboxNotificationSafely: mockWriteInboxNotificationSafely,
}));

import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";
import {
  processSavedDeadlineReminderJob,
  type SavedDeadlineReminderJob,
} from "./saved-deadline-reminder";

const ANCHOR_AT = "2026-11-03T02:00:00.000Z";

const job = {
  id: "job_1",
  data: { userId: "user_a", anchorAt: ANCHOR_AT },
} as unknown as SavedDeadlineReminderJob;

const dueItem = {
  userId: "user_a",
  competitionId: "c1",
  competitionSlug: "uiux-sprint",
  competitionTitle: "UI/UX Sprint",
  institutionSlug: "himpunan",
  registrationEndAt: new Date("2026-11-03T16:59:00.000Z"),
  daysBefore: 1,
};

afterEach(() => vi.clearAllMocks());

describe("processSavedDeadlineReminderJob", () => {
  it("writes one inbox row and sends one email covering everything still due", async () => {
    mockFindReminderRecipientEmail.mockResolvedValue("andi@example.com");
    mockListDueSavedDeadlineReminders.mockResolvedValue([dueItem]);

    await processSavedDeadlineReminderJob(job);

    expect(mockListDueSavedDeadlineReminders).toHaveBeenCalledWith(
      new Date(ANCHOR_AT),
      { userId: "user_a" },
      expect.anything(),
    );
    expect(mockWriteInboxNotificationSafely).toHaveBeenCalledTimes(1);
    expect(mockWriteInboxNotificationSafely.mock.calls[0]?.[1]).toMatchObject({
      userId: "user_a",
      type: NOTIFICATION_TYPES.savedDeadlineReminder,
      title: "Hari terakhir: UI/UX Sprint",
    });
    expect(mockSendSavedDeadlineReminderEmail).toHaveBeenCalledWith({
      toEmail: "andi@example.com",
      recipientId: "user_a",
      items: [dueItem],
      anchor: new Date(ANCHOR_AT),
    });
  });

  // Between the sweep and this job the student registered or unsaved; either should silence it.
  it("sends nothing when nothing is due any more", async () => {
    mockFindReminderRecipientEmail.mockResolvedValue("andi@example.com");
    mockListDueSavedDeadlineReminders.mockResolvedValue([]);

    await processSavedDeadlineReminderJob(job);

    expect(mockWriteInboxNotificationSafely).not.toHaveBeenCalled();
    expect(mockSendSavedDeadlineReminderEmail).not.toHaveBeenCalled();
  });

  it("sends nothing to an account that is gone, suspended or deactivated", async () => {
    mockFindReminderRecipientEmail.mockResolvedValue(null);

    await processSavedDeadlineReminderJob(job);

    expect(mockListDueSavedDeadlineReminders).not.toHaveBeenCalled();
    expect(mockSendSavedDeadlineReminderEmail).not.toHaveBeenCalled();
  });

  it("rethrows an email failure so BullMQ retries it, after the inbox row is written", async () => {
    mockFindReminderRecipientEmail.mockResolvedValue("andi@example.com");
    mockListDueSavedDeadlineReminders.mockResolvedValue([dueItem]);
    mockSendSavedDeadlineReminderEmail.mockRejectedValue(new Error("provider down"));

    await expect(processSavedDeadlineReminderJob(job)).rejects.toThrow("provider down");
    expect(mockWriteInboxNotificationSafely).toHaveBeenCalledTimes(1);
  });
});
