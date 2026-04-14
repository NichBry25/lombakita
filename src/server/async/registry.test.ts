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
  it("registers only the non-business probe job", () => {
    expect(ASYNC_JOB_REGISTRATIONS).toHaveLength(1);

    const probe = getRegistrationByJobName(ASYNC_JOB_NAMES.probePing);

    expect(probe).toBeDefined();
    expect(probe?.queueName).toBe(ASYNC_QUEUE_NAMES.infrastructure);
  });

  it("exposes queue-level processor registration", () => {
    expect(getRegisteredQueueNames()).toEqual([ASYNC_QUEUE_NAMES.infrastructure]);
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.infrastructure)).toHaveLength(1);
  });
});
