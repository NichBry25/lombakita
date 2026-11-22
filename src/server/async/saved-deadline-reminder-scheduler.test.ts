// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetAsyncQueue, mockUpsertJobScheduler, mockGetJob, mockAdd } = vi.hoisted(() => ({
  mockGetAsyncQueue: vi.fn(),
  mockUpsertJobScheduler: vi.fn(),
  mockGetJob: vi.fn(),
  mockAdd: vi.fn(),
}));

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/server/async/queue", () => ({ getAsyncQueue: mockGetAsyncQueue }));

import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import { enqueueSavedDeadlineReminder } from "@/server/async/enqueue";
import {
  SAVED_DEADLINE_REMINDER_CRON,
  SAVED_DEADLINE_REMINDER_SCHEDULER_ID,
  registerSavedDeadlineReminderSchedule,
} from "./saved-deadline-reminder-scheduler";

afterEach(() => vi.clearAllMocks());

describe("registerSavedDeadlineReminderSchedule", () => {
  const setup = () => {
    mockUpsertJobScheduler.mockResolvedValue(undefined);
    mockGetAsyncQueue.mockReturnValue({ upsertJobScheduler: mockUpsertJobScheduler });
  };

  it("schedules the sweep for 09:00 WIB every day on the infrastructure queue", async () => {
    setup();
    await registerSavedDeadlineReminderSchedule();

    expect(mockGetAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.infrastructure);
    const [, repeat, template] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(SAVED_DEADLINE_REMINDER_CRON).toBe("0 9 * * *");
    expect(repeat).toEqual({ pattern: "0 9 * * *", tz: "Asia/Jakarta" });
    expect(template?.name).toBe(ASYNC_JOB_NAMES.savedDeadlineReminderSweep);
    expect(template?.opts?.attempts).toBe(1);
  });

  // A drifting id would add a second daily sweep on every deploy, and a second email per student.
  it("always uses the same scheduler id, so a redeploy replaces rather than duplicates", async () => {
    setup();
    await registerSavedDeadlineReminderSchedule();
    await registerSavedDeadlineReminderSchedule();

    for (const call of mockUpsertJobScheduler.mock.calls) {
      expect(call[0]).toBe(SAVED_DEADLINE_REMINDER_SCHEDULER_ID);
    }
  });
});

describe("enqueueSavedDeadlineReminder", () => {
  // Two sweeps on the same day must collapse into one job per student, so one email.
  it("keys the job on the student and the sweep's date", async () => {
    mockGetJob.mockResolvedValue(null);
    mockAdd.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => ({
      id: opts.jobId,
    }));
    mockGetAsyncQueue.mockReturnValue({ getJob: mockGetJob, add: mockAdd });

    const result = await enqueueSavedDeadlineReminder({
      userId: "3f1c2b9e-0000-4000-8000-000000000001",
      anchorAt: "2026-11-03T02:00:00.000Z",
    });

    expect(mockGetAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.notifications);
    expect(result.jobId).toBe(
      "saved.deadline.reminder__3f1c2b9e-0000-4000-8000-000000000001__2026-11-03",
    );
  });
});
