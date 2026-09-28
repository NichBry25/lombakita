// @vitest-environment node

// The fail-open direction, against the REAL limiter.
//
// `checkFixedWindowLimit` is deliberately NOT mocked here. The property under test is what this
// module does when the thing it asks cannot answer, and a mock has no opinion about that — the
// question only exists on the real `server/redis/rate-limit.ts` path, which treats an unconfigured
// Redis as "feature off" and allows. Mocking it here would assert that a stub returns what the stub
// was told to return.
//
// The direction is inherited, not chosen here, and it is the correct one for a self-service upload:
// a Redis outage must not stop every candidate from attaching a resume. It bounds a sweep; it does
// not enforce a quota.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/config/env.server", () => ({ serverEnv: { redisUrl: undefined } }));

import { assertUploadUrlAllowed } from "./upload-rate-limit";

describe("with no Redis configured", () => {
  it("allows the upload URL instead of refusing it", async () => {
    await expect(assertUploadUrlAllowed("user_1")).resolves.toBeNull();
  });

  it("allows every account, not just the first", async () => {
    // An allow that lasted one call would look identical to a working limiter on a single-request
    // test. Nothing here is counted, so nothing may start being counted partway.
    const verdicts = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) => assertUploadUrlAllowed(`user_${index}`)),
    );

    expect(verdicts).toEqual([null, null, null, null, null]);
  });
});
