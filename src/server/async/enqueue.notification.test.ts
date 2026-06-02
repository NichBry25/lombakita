// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";

const { getAsyncQueue } = vi.hoisted(() => ({
  getAsyncQueue: vi.fn(),
}));

vi.mock("@/server/async/queue", () => ({ getAsyncQueue }));

import {
  enqueueRegistrationConfirmed,
  enqueueRegistrationCancelled,
  enqueueSubmissionFinalized,
} from "@/server/async/enqueue";

const makeQueue = () => ({
  getJob: vi.fn(async () => null),
  add: vi.fn(async () => ({ id: "job_1" })),
});

describe("enqueueRegistrationConfirmed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses notifications queue and registrationId as idempotency key", async () => {
    const queue = makeQueue();
    getAsyncQueue.mockReturnValue(queue);

    const result = await enqueueRegistrationConfirmed({
      registrationId: "reg_abc",
      studentId: "user_1",
      competitionId: "comp_1",
      registrationType: "individual",
    });

    expect(getAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.notifications);
    expect(queue.getJob).toHaveBeenCalledWith("registration.confirmed__reg_abc");
    expect(queue.add).toHaveBeenCalledWith(
      ASYNC_JOB_NAMES.registrationConfirmed,
      expect.objectContaining({ registrationId: "reg_abc", studentId: "user_1" }),
      { jobId: "registration.confirmed__reg_abc" },
    );
    expect(result.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);
    expect(result.jobName).toBe(ASYNC_JOB_NAMES.registrationConfirmed);
  });

  it("marks duplicate when job already exists", async () => {
    const queue = {
      getJob: vi.fn(async () => ({ id: "registration.confirmed__reg_abc" })),
      add: vi.fn(async () => ({ id: "registration.confirmed__reg_abc" })),
    };
    getAsyncQueue.mockReturnValue(queue);

    const result = await enqueueRegistrationConfirmed({
      registrationId: "reg_abc",
      studentId: "user_1",
      competitionId: "comp_1",
      registrationType: "individual",
    });

    expect(result.duplicate).toBe(true);
  });
});

describe("enqueueRegistrationCancelled", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses notifications queue and registrationId as idempotency key", async () => {
    const queue = makeQueue();
    getAsyncQueue.mockReturnValue(queue);

    const result = await enqueueRegistrationCancelled({
      registrationId: "reg_xyz",
      studentId: "user_2",
      competitionId: "comp_2",
      registrationType: "team",
    });

    expect(getAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.notifications);
    expect(queue.getJob).toHaveBeenCalledWith("registration.cancelled__reg_xyz");
    expect(queue.add).toHaveBeenCalledWith(
      ASYNC_JOB_NAMES.registrationCancelled,
      expect.objectContaining({ registrationId: "reg_xyz", registrationType: "team" }),
      { jobId: "registration.cancelled__reg_xyz" },
    );
    expect(result.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);
  });
});

describe("enqueueSubmissionFinalized", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses notifications queue and registrationId as idempotency key", async () => {
    const queue = makeQueue();
    getAsyncQueue.mockReturnValue(queue);

    const result = await enqueueSubmissionFinalized({
      submissionId: "sub_1",
      registrationId: "reg_1",
      studentId: "user_3",
      competitionId: "comp_3",
    });

    expect(getAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.notifications);
    expect(queue.getJob).toHaveBeenCalledWith("submission.finalized__reg_1");
    expect(queue.add).toHaveBeenCalledWith(
      ASYNC_JOB_NAMES.submissionFinalized,
      expect.objectContaining({ submissionId: "sub_1", registrationId: "reg_1" }),
      { jobId: "submission.finalized__reg_1" },
    );
    expect(result.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);
  });
});
