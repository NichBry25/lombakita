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
import { TEAM_CLOSE_CHECK_TIMEZONE } from "@/server/async/team-close-check-scheduler";
import {
  NAME_PROOF_SWEEP_SCHEDULER_ID,
  registerNameProofSweepSchedule,
} from "./name-proof-scheduler";

afterEach(() => vi.clearAllMocks());

describe("registerNameProofSweepSchedule", () => {
  const setup = () => {
    mockUpsertJobScheduler.mockResolvedValue(undefined);
    mockGetAsyncQueue.mockReturnValue({ upsertJobScheduler: mockUpsertJobScheduler });
  };

  it("the schedule registers once", async () => {
    setup();
    await registerNameProofSweepSchedule();
    await registerNameProofSweepSchedule();

    expect(mockGetAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.infrastructure);
    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);

    const [id, repeat, template] = mockUpsertJobScheduler.mock.calls[0] ?? [];
    expect(id).toBe("name-proof-sweep-hourly");
    expect(repeat).toEqual({ pattern: "15 * * * *", tz: TEAM_CLOSE_CHECK_TIMEZONE });
    expect(template?.name).toBe(ASYNC_JOB_NAMES.nameProofSweep);
    expect(template?.name).toBe("name.proof.sweep");
    expect(template?.data).toEqual({ scheduledFor: "15 * * * *" });
    expect(template?.opts).toEqual({ attempts: 1 });

    for (const call of mockUpsertJobScheduler.mock.calls) {
      expect(call[0]).toBe(NAME_PROOF_SWEEP_SCHEDULER_ID);
    }
  });
});
