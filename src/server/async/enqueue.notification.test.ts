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
  enqueueResultPublished,
  enqueuePaymentProofSubmitted,
  enqueuePaymentOutcome,
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

describe("enqueueResultPublished", () => {
  beforeEach(() => vi.clearAllMocks());

  const PUBLISHED_AT = new Date("2026-06-03T06:20:57.000Z"); // epoch 1780467657000

  it("includes the publish timestamp in the team idempotency key (results queue)", async () => {
    const queue = makeQueue();
    getAsyncQueue.mockReturnValue(queue);

    await enqueueResultPublished({
      registrationId: "reg_1",
      competitionId: "comp_1",
      teamId: "team_1",
      publishedAt: PUBLISHED_AT,
    });

    const expectedId = `result.published__comp_1__team_1__${PUBLISHED_AT.getTime()}`;
    expect(getAsyncQueue).toHaveBeenCalledWith(ASYNC_QUEUE_NAMES.results);
    expect(queue.getJob).toHaveBeenCalledWith(expectedId);
    expect(queue.add).toHaveBeenCalledWith(
      ASYNC_JOB_NAMES.resultPublished,
      expect.objectContaining({ competitionId: "comp_1", teamId: "team_1" }),
      { jobId: expectedId },
    );
  });

  it("includes the publish timestamp in the individual idempotency key", async () => {
    const queue = makeQueue();
    getAsyncQueue.mockReturnValue(queue);

    await enqueueResultPublished({
      registrationId: "reg_1",
      competitionId: "comp_1",
      publishedAt: PUBLISHED_AT,
    });

    expect(queue.getJob).toHaveBeenCalledWith(`result.published__reg_1__${PUBLISHED_AT.getTime()}`);
  });

  it("produces a DISTINCT job id for a later re-publish so it is not deduped", async () => {
    const queue = makeQueue();
    getAsyncQueue.mockReturnValue(queue);

    await enqueueResultPublished({
      registrationId: "reg_1",
      competitionId: "comp_1",
      teamId: "team_1",
      publishedAt: PUBLISHED_AT,
    });
    await enqueueResultPublished({
      registrationId: "reg_1",
      competitionId: "comp_1",
      teamId: "team_1",
      publishedAt: new Date(PUBLISHED_AT.getTime() + 60_000), // a later republish
    });

    const jobIdOf = (call: unknown[] | undefined) =>
      (call?.[2] as { jobId?: string } | undefined)?.jobId;
    const firstId = jobIdOf(queue.add.mock.calls[0]);
    const secondId = jobIdOf(queue.add.mock.calls[1]);
    expect(firstId).toBeDefined();
    expect(firstId).not.toBe(secondId);
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

describe("the manual lane's idempotency identities", () => {
  beforeEach(() => vi.clearAllMocks());

  const submitted = (attempt: number) => ({
    paymentId: "pay_1",
    proofId: "proof_1",
    attempt,
    competitionTitle: "Seed Coding League",
    institutionSlug: "seed-academy",
    competitionSlug: "seed-coding-league",
    institutionId: "inst_1",
    payerDisplayName: "Sari Melati",
    grossAmount: 150_000,
    currency: "IDR",
  });

  const outcome = (o: "verified" | "rejected" | "expired", attempt: number) => ({
    paymentId: "pay_1",
    registrationId: "reg_1",
    attempt,
    competitionTitle: "Seed Coding League",
    outcome: o,
    rejectionReason: null,
    resubmissionAllowed: null,
    grossAmount: 150_000,
    currency: "IDR",
  });

  it("separates a resubmitted bukti transfer from the attempt it replaces", async () => {
    const queue = makeQueue();
    getAsyncQueue.mockReturnValue(queue);

    await enqueuePaymentProofSubmitted(submitted(0));
    await enqueuePaymentProofSubmitted(submitted(1));

    const adds = queue.add.mock.calls as unknown as unknown[][];

    // The proof id is IDENTICAL across attempts — the row is reused — so the attempt is the only
    // thing separating these two jobs. Without it the second is dropped as a duplicate.
    expect(adds[0]![2]).toEqual({ jobId: "payment.proof.submitted__proof_1__0" });
    expect(adds[1]![2]).toEqual({ jobId: "payment.proof.submitted__proof_1__1" });
  });

  it("separates a second rejection of one payment from the first", async () => {
    const queue = makeQueue();
    getAsyncQueue.mockReturnValue(queue);

    await enqueuePaymentOutcome(outcome("rejected", 0));
    await enqueuePaymentOutcome(outcome("rejected", 1));

    const adds = queue.add.mock.calls as unknown as unknown[][];
    expect(adds[0]![2]).toEqual({ jobId: "payment.outcome__pay_1__rejected__0" });
    expect(adds[1]![2]).toEqual({ jobId: "payment.outcome__pay_1__rejected__1" });
  });

  it("still collapses a retry of one announcement", async () => {
    // The attempt widens the identity; it must not dissolve it. A retry of the SAME announcement
    // resolves to the same job id and is reported as a duplicate.
    const queue = {
      getJob: vi.fn(async () => ({ id: "payment.outcome__pay_1__verified__2" })),
      add: vi.fn(async () => ({ id: "payment.outcome__pay_1__verified__2" })),
    };
    getAsyncQueue.mockReturnValue(queue);

    const result = await enqueuePaymentOutcome(outcome("verified", 2));

    expect(queue.getJob).toHaveBeenCalledWith("payment.outcome__pay_1__verified__2");
    expect(result.duplicate).toBe(true);
  });
});
