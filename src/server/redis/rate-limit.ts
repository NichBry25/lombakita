import * as Sentry from "@sentry/nextjs";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/server/redis/client";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/redis/rate-limit");

// Redis-backed rate-limit primitives for the auth entry surface.
//
// Two fail-open limiters (fixed-window request count; failed-attempt count) and one fail-CLOSED
// single-use consume. The asymmetry is deliberate:
//   - The limiters are security-ADDITIVE. If Redis is unreachable they must NOT lock every user out
//     of sign-in, so they fail OPEN (allow) and record the degradation to Sentry.
//   - The single-use consume is a replay guard. It must POSITIVELY confirm the carrier has not been
//     used before, so if Redis cannot confirm it fails CLOSED (the error propagates and the caller
//     refuses the operation).
// When REDIS_URL is not configured (local dev without Redis) the limiters silently allow — this is a
// "feature off" state, not a degradation, so it is not reported. The single-use consume treats the
// same state as an inability to confirm and still fails closed.

// Records a Redis degradation to both the structured log and Sentry. Called by every path that
// catches a live Redis error so an operator sees when the auth limiter is running blind.
const reportRedisDegradation = (operation: string, error: unknown): void => {
  logger.warn("auth.rate-limit.redis_degraded", {
    operation,
    error: error instanceof Error ? error.message : String(error),
  });
  Sentry.captureException(error, {
    level: "warning",
    tags: { subsystem: "auth-rate-limit", operation },
  });
};

// The default web client is lazyConnect with enableOfflineQueue:false, so a command issued before
// the socket is up rejects immediately. Mirror the health probe: connect when the client is still in
// its initial "wait" state. A concurrent connect() (another request already connecting) rejects with
// "already connecting"; that is swallowed here — the command below still runs once the shared
// connection is up, or rejects and is handled by the caller's own try/catch.
const ensureConnected = async (redis: ReturnType<typeof getRedisClient>): Promise<void> => {
  if (redis.status === "wait") {
    await redis.connect().catch(() => {});
  }
};

// Runs a Redis command through the shared client, throwing on any failure. Callers decide whether to
// fail open (catch → allow) or fail closed (let it throw). Throws synchronously via getRedisClient()
// if REDIS_URL is unset, so every caller guards on serverEnv.redisUrl first.
const runRedisCommand = async <T>(run: (redis: ReturnType<typeof getRedisClient>) => Promise<T>): Promise<T> => {
  const redis = getRedisClient();
  await ensureConnected(redis);
  return run(redis);
};

export type FixedWindowResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

// Fixed-window request limiter. INCRs the window key, sets the TTL on the first increment, and blocks
// once the count exceeds `limit`. `retryAfterSeconds` is read from the key's live TTL so the caller
// can emit an accurate Retry-After. Fail-open: any Redis error (or absent Redis) returns allowed.
export const checkFixedWindowLimit = async (params: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<FixedWindowResult> => {
  if (!serverEnv.redisUrl) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  try {
    return await runRedisCommand(async (redis) => {
      const count = await redis.incr(params.key);

      if (count === 1) {
        await redis.expire(params.key, params.windowSeconds);
      }

      if (count > params.limit) {
        let ttl = await redis.ttl(params.key);
        // ttl < 0 means the key has no expiry (a lost EXPIRE) or vanished mid-check; re-arm it so the
        // window can never become a permanent lockout, and fall back to the full window as the hint.
        if (ttl < 0) {
          await redis.expire(params.key, params.windowSeconds);
          ttl = params.windowSeconds;
        }
        return { allowed: false, retryAfterSeconds: ttl };
      }

      return { allowed: true, retryAfterSeconds: 0 };
    });
  } catch (error) {
    reportRedisDegradation("fixed-window", error);
    return { allowed: true, retryAfterSeconds: 0 };
  }
};

// Read-only failed-attempt check. Returns true when the recorded failure count for `key` has reached
// `limit`. Fail-open: any Redis error (or absent Redis) returns false (not limited).
export const isFailedAttemptLimited = async (params: {
  key: string;
  limit: number;
}): Promise<boolean> => {
  if (!serverEnv.redisUrl) {
    return false;
  }

  try {
    return await runRedisCommand(async (redis) => {
      const raw = await redis.get(params.key);
      const count = raw ? Number.parseInt(raw, 10) : 0;
      return Number.isFinite(count) && count >= params.limit;
    });
  } catch (error) {
    reportRedisDegradation("failed-attempt-check", error);
    return false;
  }
};

// Records one failed attempt: INCR the counter, arm the TTL on the first failure. Fail-open: a Redis
// error is reported and swallowed (a missed record never blocks the auth response).
export const recordFailedAttempt = async (params: {
  key: string;
  windowSeconds: number;
}): Promise<void> => {
  if (!serverEnv.redisUrl) {
    return;
  }

  try {
    await runRedisCommand(async (redis) => {
      const count = await redis.incr(params.key);
      if (count === 1) {
        await redis.expire(params.key, params.windowSeconds);
      }
    });
  } catch (error) {
    reportRedisDegradation("failed-attempt-record", error);
  }
};

// Clears the failed-attempt counter for `key` (called on a successful login so successes never
// accumulate toward the limit and a good login resets a partial lockout). Fail-open.
export const clearFailedAttempts = async (key: string): Promise<void> => {
  if (!serverEnv.redisUrl) {
    return;
  }

  try {
    await runRedisCommand(async (redis) => {
      await redis.del(key);
    });
  } catch (error) {
    reportRedisDegradation("failed-attempt-clear", error);
  }
};

// Atomically consumes a single-use token. Returns true when this call was the first to set `key`
// (the operation may proceed) and false when the key already existed (a replay). Fail-CLOSED: unlike
// the limiters above, a Redis error — or an unconfigured Redis — THROWS so the caller refuses the
// operation rather than allowing an unconfirmed second use. The degradation is reported before the
// throw.
export const consumeSingleUseToken = async (params: {
  key: string;
  ttlSeconds: number;
}): Promise<boolean> => {
  if (!serverEnv.redisUrl) {
    throw new Error("single-use consume unavailable: REDIS_URL not configured");
  }

  try {
    return await runRedisCommand(async (redis) => {
      // SET key 1 EX <ttl> NX — the atomic set-if-absent-with-expiry. ioredis returns "OK" when the
      // key was set (first use) and null when it already existed (replay).
      const result = await redis.set(params.key, "1", "EX", Math.max(1, params.ttlSeconds), "NX");
      return result === "OK";
    });
  } catch (error) {
    reportRedisDegradation("single-use-consume", error);
    throw error;
  }
};
