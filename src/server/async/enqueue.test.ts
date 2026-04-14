// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";

const { getAsyncQueue } = vi.hoisted(() => ({
  getAsyncQueue: vi.fn(),
}));

vi.mock("@/server/async/queue", () => ({
  getAsyncQueue,
}));

import { enqueueProbeJob } from "@/server/async/enqueue";

describe("enqueueProbeJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses deterministic job ids and reports duplicate state", async () => {
    const queue = {
      getJob: vi.fn(async () => ({ id: "existing-job" })),
      add: vi.fn(async () => ({ id: "existing-job" })),
    };

    getAsyncQueue.mockReturnValue(queue);

    const result = await enqueueProbeJob({
      probeId: "probe-123",
      triggeredBy: "script",
    });

    expect(getAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.infrastructure);
    expect(queue.getJob).toHaveBeenCalledWith("infrastructure.probe.ping__probe-123");
    expect(queue.add).toHaveBeenCalledWith(
      ASYNC_JOB_NAMES.probePing,
      expect.objectContaining({
        probeId: "probe-123",
        triggeredBy: "script",
      }),
      { jobId: "infrastructure.probe.ping__probe-123" },
    );
    expect(result.duplicate).toBe(true);
    expect(result.jobId).toBe("existing-job");
  });
});
