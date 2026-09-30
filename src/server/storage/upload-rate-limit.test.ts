// @vitest-environment node

// MANUAL-D57: the shared presigned-upload budget.
//
// `checkFixedWindowLimit` is mocked here so the window arithmetic is not re-tested — it has its own
// suite in server/redis/rate-limit.test.ts. What is asserted is this module's own decisions: which
// key it counts, whether the refusal stops the request, and what the refusal says. The fail-open
// direction is NOT asserted here, because a mock cannot have an opinion about an unreachable Redis;
// it lives in upload-rate-limit-fail-open.test.ts against the real limiter.

import { afterEach, describe, expect, it, vi } from "vitest";

const { checkFixedWindowLimit } = vi.hoisted(() => ({ checkFixedWindowLimit: vi.fn() }));

vi.mock("@/server/redis/rate-limit", () => ({ checkFixedWindowLimit }));

import {
  UPLOAD_URL_RATE_LIMIT,
  assertUploadUrlAllowed,
  uploadUrlRateLimitedResponse,
} from "./upload-rate-limit";

const ALLOWED = { allowed: true, retryAfterSeconds: 0 };
const REFUSED = { allowed: false, retryAfterSeconds: 42 };

afterEach(() => vi.clearAllMocks());

describe("assertUploadUrlAllowed", () => {
  it("allows by returning null, so the caller continues", async () => {
    checkFixedWindowLimit.mockResolvedValue(ALLOWED);

    await expect(assertUploadUrlAllowed("user_1")).resolves.toBeNull();
  });

  it("counts one bucket per USER, under the module's own prefix", async () => {
    checkFixedWindowLimit.mockResolvedValue(ALLOWED);

    await assertUploadUrlAllowed("user_1");

    expect(checkFixedWindowLimit).toHaveBeenCalledWith({
      key: `${UPLOAD_URL_RATE_LIMIT.keyPrefix}user_1`,
      limit: UPLOAD_URL_RATE_LIMIT.limit,
      windowSeconds: UPLOAD_URL_RATE_LIMIT.windowSeconds,
    });
  });

  it("gives two accounts two buckets", async () => {
    // The key is the identity, not the route. A caller holding both a candidate and a recruiter
    // account must not be able to draw the allowance twice against one bucket.
    checkFixedWindowLimit.mockResolvedValue(ALLOWED);

    await assertUploadUrlAllowed("user_1");
    await assertUploadUrlAllowed("user_2");

    const keys = checkFixedWindowLimit.mock.calls.map((call) => (call[0] as { key: string }).key);

    expect(keys).toEqual([
      `${UPLOAD_URL_RATE_LIMIT.keyPrefix}user_1`,
      `${UPLOAD_URL_RATE_LIMIT.keyPrefix}user_2`,
    ]);
  });

  it("returns the refusal rather than throwing, so it can sit at function scope", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    const response = await assertUploadUrlAllowed("user_1");

    expect(response).not.toBeNull();
    expect(response?.status).toBe(429);
  });
});

describe("the over-limit response", () => {
  it("is a 429 carrying the retry hint Redis reported", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    const response = await assertUploadUrlAllowed("user_1");

    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("42");
  });

  it("says what a person waiting on it needs to know, in Indonesian", async () => {
    const body = await uploadUrlRateLimitedResponse(42).json();

    expect(body).toEqual({
      error: {
        code: "rate_limited",
        message: "Terlalu banyak permintaan unggah. Coba lagi dalam beberapa menit.",
      },
    });
  });

  it("is what the guard actually returns, not a shape that exists beside it", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    const returned = await assertUploadUrlAllowed("user_1");
    const direct = uploadUrlRateLimitedResponse(42);

    expect(returned?.status).toBe(direct.status);
    expect(returned?.headers.get("Retry-After")).toBe(direct.headers.get("Retry-After"));
    expect(await returned?.text()).toBe(await direct.text());
  });
});
