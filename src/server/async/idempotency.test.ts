// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ASYNC_JOB_NAMES } from "@/server/async/contracts";
import { buildAsyncJobId, sanitizeIdempotencyKey } from "@/server/async/idempotency";

describe("async idempotency conventions", () => {
  it("builds deterministic job ids", () => {
    const jobIdA = buildAsyncJobId(ASYNC_JOB_NAMES.probePing, "proof-1");
    const jobIdB = buildAsyncJobId(ASYNC_JOB_NAMES.probePing, "proof-1");

    expect(jobIdA).toBe(jobIdB);
    expect(jobIdA).toBe("infrastructure.probe.ping__proof-1");
  });

  it("sanitizes unsupported characters", () => {
    expect(sanitizeIdempotencyKey("proof id / 01")).toBe("proof_id___01");
  });

  it("rejects empty keys", () => {
    expect(() => sanitizeIdempotencyKey("   ")).toThrow("idempotency key must not be empty");
  });
});
