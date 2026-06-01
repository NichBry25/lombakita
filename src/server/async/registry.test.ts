// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import {
  ASYNC_JOB_REGISTRATIONS,
  getQueueRegistrations,
  getRegisteredQueueNames,
  getRegistrationByJobName,
} from "@/server/async/registry";

describe("async queue registration baseline", () => {
  it("registers probe job, competition search sync job, and result published job", () => {
    expect(ASYNC_JOB_REGISTRATIONS).toHaveLength(3);

    const probe = getRegistrationByJobName(ASYNC_JOB_NAMES.probePing);
    expect(probe).toBeDefined();
    expect(probe?.queueName).toBe(ASYNC_QUEUE_NAMES.infrastructure);

    const syncJob = getRegistrationByJobName(ASYNC_JOB_NAMES.competitionSearchSync);
    expect(syncJob).toBeDefined();
    expect(syncJob?.queueName).toBe(ASYNC_QUEUE_NAMES.competition);

    const resultJob = getRegistrationByJobName(ASYNC_JOB_NAMES.resultPublished);
    expect(resultJob).toBeDefined();
    expect(resultJob?.queueName).toBe(ASYNC_QUEUE_NAMES.results);
  });

  it("exposes queue-level processor registrations", () => {
    expect(getRegisteredQueueNames()).toEqual(
      expect.arrayContaining([
        ASYNC_QUEUE_NAMES.infrastructure,
        ASYNC_QUEUE_NAMES.competition,
        ASYNC_QUEUE_NAMES.results,
      ]),
    );
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.infrastructure)).toHaveLength(1);
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.competition)).toHaveLength(1);
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.results)).toHaveLength(1);
  });
});
