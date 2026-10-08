// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Job } from "bullmq";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";

const { getAsyncQueue } = vi.hoisted(() => ({
  getAsyncQueue: vi.fn(),
}));

vi.mock("@/server/async/queue", () => ({
  getAsyncQueue,
}));

import {
  enqueueAsyncJob,
  enqueueCompetitionSearchSync,
  enqueueProbeJob,
} from "@/server/async/enqueue";

const createAcceptingQueue = () => ({
  getJob: vi.fn(async () => undefined),
  add: vi.fn(async (_name: string, _payload: unknown, options: { jobId: string }) => ({
    id: options.jobId,
  })),
});

const validateBullmqJobId = (jobId: string): void => {
  const validateOptions = Reflect.get(Job.prototype, "validateOptions") as (
    this: { name: string; opts: { jobId: string } },
    jobData: { data: string },
  ) => void;
  validateOptions.call(
    { name: ASYNC_JOB_NAMES.competitionSearchSync, opts: { jobId } },
    { data: "{}" },
  );
};

describe("enqueueCompetitionSearchSync", () => {
  const competitionId = "12345678-1234-1234-1234-123456789abc";

  beforeEach(() => {
    vi.clearAllMocks();
    getAsyncQueue.mockReturnValue(createAcceptingQueue());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["upsert", "remove"] as const)("builds a BullMQ-valid id for %s", async (action) => {
    vi.spyOn(Date, "now").mockReturnValue(1791331200000);

    const result = await enqueueCompetitionSearchSync({ competitionId, action });

    expect(() => validateBullmqJobId(result.jobId)).not.toThrow();
    expect(result.jobId).not.toContain(":");
    expect(result.jobId).not.toMatch(/^\d+$/);
    expect(result.idempotencyKey).toBe(`${competitionId}__${action}__1791331200000`);
    expect(result.jobId).toBe(`competition.search.sync__${result.idempotencyKey}`);
  });

  it.each(["upsert", "remove"] as const)(
    "uses distinct job ids for repeated %s enqueues in different milliseconds",
    async (action) => {
      vi.spyOn(Date, "now").mockReturnValueOnce(1791331200000).mockReturnValueOnce(1791331200001);

      const first = await enqueueCompetitionSearchSync({ competitionId, action });
      const second = await enqueueCompetitionSearchSync({ competitionId, action });

      expect(second.jobId).not.toBe(first.jobId);
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    },
  );
});

describe("enqueueAsyncJob colon guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["invalid:key", "legacy:repeat:key"])(
    "rejects %s before queue.add through the production probe helper",
    async (probeId) => {
      const queue = createAcceptingQueue();
      getAsyncQueue.mockReturnValue(queue);

      const error = await enqueueProbeJob({ probeId, triggeredBy: "script" }).catch(
        (caught: unknown) => caught,
      );

      expect(queue.add, "colon guard must prevent queue.add").not.toHaveBeenCalled();
      expect(queue.getJob).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(ASYNC_JOB_NAMES.probePing);
      expect((error as Error).message).toContain(":");
    },
  );

  it("rejects a colon id on a direct central enqueue with the job name", async () => {
    const queue = createAcceptingQueue();
    getAsyncQueue.mockReturnValue(queue);

    await expect(
      enqueueAsyncJob({
        jobName: ASYNC_JOB_NAMES.competitionSearchSync,
        idempotencyKey: "competition:upsert",
        payload: { competitionId: "competition", action: "upsert" },
      }),
    ).rejects.toThrow(ASYNC_JOB_NAMES.competitionSearchSync);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

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
