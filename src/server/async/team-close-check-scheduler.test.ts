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
  registerTeamCloseCheckSchedule,
  TEAM_CLOSE_CHECK_CRON,
  TEAM_CLOSE_CHECK_SCHEDULER_ID,
  TEAM_CLOSE_CHECK_TIMEZONE,
} from "./team-close-check-scheduler";

afterEach(() => vi.clearAllMocks());

describe("registerTeamCloseCheckSchedule", () => {
  const setup = () => {
    mockUpsertJobScheduler.mockResolvedValue(undefined);
    mockGetAsyncQueue.mockReturnValue({ upsertJobScheduler: mockUpsertJobScheduler });
  };

  it("schedules the team close check on the infrastructure queue every hour", async () => {
    setup();
    await registerTeamCloseCheckSchedule();

    expect(mockGetAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.infrastructure);
    const [, repeat, template] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(repeat).toEqual({ pattern: "0 * * * *", tz: "Asia/Jakarta" });
    expect(repeat).toEqual({ pattern: TEAM_CLOSE_CHECK_CRON, tz: TEAM_CLOSE_CHECK_TIMEZONE });
    expect(template?.name).toBe(ASYNC_JOB_NAMES.teamCloseCheck);
    expect(template?.data).toEqual({ scheduledFor: "0 * * * *" });
  });

  // BullMQ keys a schedule by its id, so a drifting id would double the hourly run on every
  // redeploy.
  it("always uses the same fixed scheduler id, so a redeploy replaces rather than duplicates", async () => {
    setup();
    await registerTeamCloseCheckSchedule();
    await registerTeamCloseCheckSchedule();

    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
    for (const call of mockUpsertJobScheduler.mock.calls) {
      expect(call[0]).toBe("team-close-check-hourly");
      expect(call[0]).toBe(TEAM_CLOSE_CHECK_SCHEDULER_ID);
    }
  });

  it("asks for a single attempt", async () => {
    setup();
    await registerTeamCloseCheckSchedule();

    const [, , template] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(template?.opts).toEqual({ attempts: 1 });
  });

  it("pins a timezone rather than inheriting the host's", async () => {
    setup();
    await registerTeamCloseCheckSchedule();

    const [, repeat] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(repeat?.tz).toBe("Asia/Jakarta");
  });
});
