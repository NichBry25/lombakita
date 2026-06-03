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
  it("registers all expected jobs across infrastructure, competition, results, and notifications queues", () => {
    // Step 6.5.1 added competition.edited + competition.cancelled to the notifications queue.
    expect(ASYNC_JOB_REGISTRATIONS).toHaveLength(8);

    const probe = getRegistrationByJobName(ASYNC_JOB_NAMES.probePing);
    expect(probe).toBeDefined();
    expect(probe?.queueName).toBe(ASYNC_QUEUE_NAMES.infrastructure);

    const syncJob = getRegistrationByJobName(ASYNC_JOB_NAMES.competitionSearchSync);
    expect(syncJob).toBeDefined();
    expect(syncJob?.queueName).toBe(ASYNC_QUEUE_NAMES.competition);

    const resultJob = getRegistrationByJobName(ASYNC_JOB_NAMES.resultPublished);
    expect(resultJob).toBeDefined();
    expect(resultJob?.queueName).toBe(ASYNC_QUEUE_NAMES.results);

    const confirmedJob = getRegistrationByJobName(ASYNC_JOB_NAMES.registrationConfirmed);
    expect(confirmedJob).toBeDefined();
    expect(confirmedJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const cancelledJob = getRegistrationByJobName(ASYNC_JOB_NAMES.registrationCancelled);
    expect(cancelledJob).toBeDefined();
    expect(cancelledJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const finalizedJob = getRegistrationByJobName(ASYNC_JOB_NAMES.submissionFinalized);
    expect(finalizedJob).toBeDefined();
    expect(finalizedJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const competitionEditedJob = getRegistrationByJobName(ASYNC_JOB_NAMES.competitionEdited);
    expect(competitionEditedJob).toBeDefined();
    expect(competitionEditedJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const competitionCancelledJob = getRegistrationByJobName(ASYNC_JOB_NAMES.competitionCancelled);
    expect(competitionCancelledJob).toBeDefined();
    expect(competitionCancelledJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);
  });

  it("exposes queue-level processor registrations", () => {
    expect(getRegisteredQueueNames()).toEqual(
      expect.arrayContaining([
        ASYNC_QUEUE_NAMES.infrastructure,
        ASYNC_QUEUE_NAMES.competition,
        ASYNC_QUEUE_NAMES.results,
        ASYNC_QUEUE_NAMES.notifications,
      ]),
    );
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.infrastructure)).toHaveLength(1);
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.competition)).toHaveLength(1);
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.results)).toHaveLength(1);
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.notifications)).toHaveLength(5);
  });
});
