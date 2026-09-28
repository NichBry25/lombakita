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
  EMAIL_EGRESS_CRON,
  EMAIL_EGRESS_SCHEDULER_ID,
  EMAIL_EGRESS_TIMEZONE,
  registerEmailEgressSchedule,
} from "./email-egress-scheduler";

afterEach(() => vi.clearAllMocks());

describe("registerEmailEgressSchedule", () => {
  const setup = () => {
    mockUpsertJobScheduler.mockResolvedValue(undefined);
    mockGetAsyncQueue.mockReturnValue({ upsertJobScheduler: mockUpsertJobScheduler });
  };

  it("schedules the egress probe on the infrastructure queue", async () => {
    setup();
    await registerEmailEgressSchedule();

    expect(mockGetAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.infrastructure);
    const [, repeat, template] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(repeat).toEqual({ pattern: EMAIL_EGRESS_CRON, tz: EMAIL_EGRESS_TIMEZONE });
    expect(template?.name).toBe(ASYNC_JOB_NAMES.emailEgressProbe);
  });

  // The same property the retention sweep relies on, and it matters more here: this scheduler is
  // registered from a worker that restarts on every deploy, and a drifting id would add a second
  // daily probe rather than replacing the first.
  it("always uses the same fixed scheduler id, so a redeploy replaces rather than duplicates", async () => {
    setup();
    await registerEmailEgressSchedule();
    await registerEmailEgressSchedule();

    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
    for (const call of mockUpsertJobScheduler.mock.calls) {
      expect(call[0]).toBe(EMAIL_EGRESS_SCHEDULER_ID);
    }
  });

  // Three attempts, unlike the two sweeps: the sweeps isolate per-row failures and tomorrow's run is
  // their retry, while this job's whole subject is one send, so a retry is the only thing that
  // separates a provider blip from a permanently refused identity.
  it("retries three times on an exponential backoff", async () => {
    setup();
    await registerEmailEgressSchedule();

    const [, , template] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(template?.opts?.attempts).toBe(3);
    expect(template?.opts?.backoff).toEqual({ type: "exponential", delay: 60_000 });
  });

  it("pins a timezone rather than inheriting the host's", async () => {
    setup();
    await registerEmailEgressSchedule();

    const [, repeat] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(repeat?.tz).toBe("Asia/Jakarta");
  });
});
