// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ASYNC_JOB_DEFAULT_OPTIONS } from "@/server/async/config";

describe("ASYNC_JOB_DEFAULT_OPTIONS", () => {
  it("uses shared retry/backoff conventions", () => {
    expect(ASYNC_JOB_DEFAULT_OPTIONS.attempts).toBe(3);
    expect(ASYNC_JOB_DEFAULT_OPTIONS.backoff).toEqual({
      type: "exponential",
      delay: 1000,
    });
  });

  it("uses bounded retention policies", () => {
    expect(ASYNC_JOB_DEFAULT_OPTIONS.removeOnComplete).toEqual({
      age: 3600,
      count: 1000,
    });

    expect(ASYNC_JOB_DEFAULT_OPTIONS.removeOnFail).toEqual({
      age: 86400,
      count: 5000,
    });
  });
});
