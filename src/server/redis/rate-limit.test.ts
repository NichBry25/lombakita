// @vitest-environment node
//
// Step 6.5-HARDENING.1 — Redis-backed rate-limit primitive. These tests drive the primitive against
// a fake ioredis client (mocked getRedisClient) and assert the fail-open limiters (fixed-window,
// failed-attempt) and the fail-closed single-use consume, including the Redis-error branches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: captureExceptionMock }));

// Mutable (and hoisted, since the mock factory is hoisted above it) so individual tests can toggle
// "Redis not configured".
const { serverEnvMock } = vi.hoisted(() => ({
  serverEnvMock: { redisUrl: "redis://localhost:6379" as string | undefined },
}));
vi.mock("@/config/env.server", () => ({ serverEnv: serverEnvMock }));

const { getRedisClientMock } = vi.hoisted(() => ({ getRedisClientMock: vi.fn() }));
vi.mock("@/server/redis/client", () => ({ getRedisClient: getRedisClientMock }));

import {
  checkFixedWindowLimit,
  clearFailedAttempts,
  consumeSingleUseToken,
  isFailedAttemptLimited,
  recordFailedAttempt,
} from "@/server/redis/rate-limit";

type FakeRedis = {
  status: string;
  connect: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  ttl: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
};

let redis: FakeRedis;

beforeEach(() => {
  serverEnvMock.redisUrl = "redis://localhost:6379";
  redis = {
    status: "ready",
    connect: vi.fn(async () => undefined),
    incr: vi.fn(),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(),
    get: vi.fn(),
    del: vi.fn(async () => 1),
    set: vi.fn(),
  };
  getRedisClientMock.mockReturnValue(redis);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("checkFixedWindowLimit — fixed-window request limiter", () => {
  it("allows the first request and arms the TTL on the first increment", async () => {
    redis.incr.mockResolvedValue(1);

    const result = await checkFixedWindowLimit({ key: "rl:x", limit: 3, windowSeconds: 60 });

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(redis.incr).toHaveBeenCalledWith("rl:x");
    expect(redis.expire).toHaveBeenCalledWith("rl:x", 60);
  });

  it("does not re-arm the TTL on subsequent increments within the window", async () => {
    redis.incr.mockResolvedValue(2);

    const result = await checkFixedWindowLimit({ key: "rl:x", limit: 3, windowSeconds: 60 });

    expect(result.allowed).toBe(true);
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("blocks once the count exceeds the limit and reports the live TTL as retryAfter", async () => {
    redis.incr.mockResolvedValue(4);
    redis.ttl.mockResolvedValue(42);

    const result = await checkFixedWindowLimit({ key: "rl:x", limit: 3, windowSeconds: 60 });

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 42 });
  });

  it("re-arms a lost TTL (ttl < 0) so a blocked window can never become a permanent lockout", async () => {
    redis.incr.mockResolvedValue(4);
    redis.ttl.mockResolvedValue(-1);

    const result = await checkFixedWindowLimit({ key: "rl:x", limit: 3, windowSeconds: 60 });

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(redis.expire).toHaveBeenCalledWith("rl:x", 60);
  });

  it("fails open (allowed) and records to Sentry on a Redis error", async () => {
    redis.incr.mockRejectedValue(new Error("redis down"));

    const result = await checkFixedWindowLimit({ key: "rl:x", limit: 3, windowSeconds: 60 });

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it("allows without touching Redis when REDIS_URL is not configured (no alert)", async () => {
    serverEnvMock.redisUrl = undefined;

    const result = await checkFixedWindowLimit({ key: "rl:x", limit: 3, windowSeconds: 60 });

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(getRedisClientMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});

describe("failed-attempt limiter", () => {
  it("isFailedAttemptLimited is read-only and true only at/over the limit", async () => {
    redis.get.mockResolvedValueOnce("5");
    expect(await isFailedAttemptLimited({ key: "rl:f", limit: 5 })).toBe(true);

    redis.get.mockResolvedValueOnce("2");
    expect(await isFailedAttemptLimited({ key: "rl:f", limit: 5 })).toBe(false);

    redis.get.mockResolvedValueOnce(null);
    expect(await isFailedAttemptLimited({ key: "rl:f", limit: 5 })).toBe(false);

    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("recordFailedAttempt increments and arms the TTL only on the first failure", async () => {
    redis.incr.mockResolvedValueOnce(1);
    await recordFailedAttempt({ key: "rl:f", windowSeconds: 900 });
    expect(redis.expire).toHaveBeenCalledWith("rl:f", 900);

    redis.expire.mockClear();
    redis.incr.mockResolvedValueOnce(3);
    await recordFailedAttempt({ key: "rl:f", windowSeconds: 900 });
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("clearFailedAttempts deletes the counter key (success resets state)", async () => {
    await clearFailedAttempts("rl:f");
    expect(redis.del).toHaveBeenCalledWith("rl:f");
  });

  it("fails open (not limited) and records to Sentry on a Redis error", async () => {
    redis.get.mockRejectedValue(new Error("redis down"));

    expect(await isFailedAttemptLimited({ key: "rl:f", limit: 5 })).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});

describe("consumeSingleUseToken — fail-closed single-use", () => {
  it("returns true on first use (SET NX set the key)", async () => {
    redis.set.mockResolvedValue("OK");

    const result = await consumeSingleUseToken({ key: "nonce:1", ttlSeconds: 100 });

    expect(result).toBe(true);
    expect(redis.set).toHaveBeenCalledWith("nonce:1", "1", "EX", 100, "NX");
  });

  it("returns false on replay (key already existed)", async () => {
    redis.set.mockResolvedValue(null);

    const result = await consumeSingleUseToken({ key: "nonce:1", ttlSeconds: 100 });

    expect(result).toBe(false);
  });

  it("throws (fails closed) and records to Sentry on a Redis error", async () => {
    redis.set.mockRejectedValue(new Error("redis down"));

    await expect(consumeSingleUseToken({ key: "nonce:1", ttlSeconds: 100 })).rejects.toThrow();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it("throws (fails closed) when REDIS_URL is not configured", async () => {
    serverEnvMock.redisUrl = undefined;

    await expect(consumeSingleUseToken({ key: "nonce:1", ttlSeconds: 100 })).rejects.toThrow();
    expect(getRedisClientMock).not.toHaveBeenCalled();
  });

  it("clamps a non-positive TTL to at least 1 second", async () => {
    redis.set.mockResolvedValue("OK");

    await consumeSingleUseToken({ key: "nonce:1", ttlSeconds: 0 });

    expect(redis.set).toHaveBeenCalledWith("nonce:1", "1", "EX", 1, "NX");
  });
});
