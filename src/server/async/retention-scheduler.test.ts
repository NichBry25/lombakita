// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetAsyncQueue, mockUpsertJobScheduler } = vi.hoisted(() => ({
  mockGetAsyncQueue: vi.fn(),
  mockUpsertJobScheduler: vi.fn(),
}));

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/server/async/queue", () => ({ getAsyncQueue: mockGetAsyncQueue }));

import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import {
  registerRetentionPurgeSchedule,
  RETENTION_PURGE_CRON,
  RETENTION_PURGE_SCHEDULER_ID,
  RETENTION_PURGE_TIMEZONE,
} from "./retention-scheduler";

afterEach(() => vi.clearAllMocks());

describe("registerRetentionPurgeSchedule", () => {
  const setup = () => {
    mockUpsertJobScheduler.mockResolvedValue(undefined);
    mockGetAsyncQueue.mockReturnValue({ upsertJobScheduler: mockUpsertJobScheduler });
  };

  it("schedules the retention job on the infrastructure queue", async () => {
    setup();
    await registerRetentionPurgeSchedule();

    expect(mockGetAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.infrastructure);
    const [, repeat, template] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(repeat).toEqual({ pattern: RETENTION_PURGE_CRON, tz: RETENTION_PURGE_TIMEZONE });
    expect(template?.name).toBe(ASYNC_JOB_NAMES.retentionPurge);
  });

  // The whole reason this is safe to call on every worker boot: BullMQ keys a schedule by its id,
  // so re-registering replaces rather than adds. A drifting id would double the daily run on
  // every redeploy.
  it("always uses the same fixed scheduler id, so a redeploy replaces rather than duplicates", async () => {
    setup();
    await registerRetentionPurgeSchedule();
    await registerRetentionPurgeSchedule();

    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
    for (const call of mockUpsertJobScheduler.mock.calls) {
      expect(call[0]).toBe(RETENTION_PURGE_SCHEDULER_ID);
    }
  });

  // The job isolates per-competition failures itself, so a BullMQ retry would only re-walk the
  // competitions that already succeeded. Tomorrow's run is the retry.
  it("asks for a single attempt", async () => {
    setup();
    await registerRetentionPurgeSchedule();

    const [, , template] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(template?.opts?.attempts).toBe(1);
  });

  it("pins a timezone rather than inheriting the host's", async () => {
    setup();
    await registerRetentionPurgeSchedule();

    const [, repeat] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(repeat?.tz).toBe("Asia/Jakarta");
  });
});
