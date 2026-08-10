import * as Sentry from "@sentry/nextjs";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/server/redis/client";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/redis/rate-limit");

// Redis-backed rate-limit primitives for the auth surfaces.
//
// The direction each primitive fails in is chosen per SURFACE, not per primitive, and is the whole
// reason there are two fixed-window functions rather than one with a flag:
//   - SELF-SERVICE limiters (fixed-window request count; failed-attempt count) are
//     security-ADDITIVE. If Redis is unreachable they must NOT lock every user out of sign-in, so
//     they fail OPEN (allow) and record the degradation to Sentry.
//   - OPERATIONAL limiting (checkFixedWindowLimitFailClosed) guards platform_ops / finance_ops
//     capability, where refusing is the safe answer — the same asymmetry DEC-0112 applies to the
//     live role read and DEC-0134 to MFA. It fails CLOSED.
//   - The single-use consume and the stored grant are replay guards. They must POSITIVELY confirm,
//     so if Redis cannot confirm they fail CLOSED (the error propagates and the caller refuses).
// When REDIS_URL is not configured (local dev without Redis) the FAIL-OPEN limiters silently allow —
// that is a "feature off" state, not a degradation, so it is not reported. Everything fail-closed
// treats the same state as an inability to confirm and refuses.

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
const runRedisCommand = async <T>(
  run: (redis: ReturnType<typeof getRedisClient>) => Promise<T>,
): Promise<T> => {
  const redis = getRedisClient();
  await ensureConnected(redis);
  return run(redis);
};

export type FixedWindowResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export type FixedWindowParams = {
  key: string;
  limit: number;
  windowSeconds: number;
};

// The window arithmetic itself, with no opinion about what an unreachable Redis means. INCRs the
// window key, arms the TTL on the first increment, and blocks once the count exceeds `limit`.
// `retryAfterSeconds` is read from the key's live TTL so the caller can emit an accurate
// Retry-After. Throws on any Redis failure — the two exported wrappers below are what decide
// whether that throw becomes "allow" or "refuse".
const runFixedWindow = async (params: FixedWindowParams): Promise<FixedWindowResult> => {
  return runRedisCommand(async (redis) => {
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
};

// Fixed-window request limiter, FAIL-OPEN: any Redis error (or absent Redis) returns allowed. This
// is the self-service auth surface's limiter — it guards sign-in and the identify oracle, where a
// Redis blip locking every user out of the product is a worse outcome than the sweep it prevents.
export const checkFixedWindowLimit = async (
  params: FixedWindowParams,
): Promise<FixedWindowResult> => {
  if (!serverEnv.redisUrl) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  try {
    return await runFixedWindow(params);
  } catch (error) {
    reportRedisDegradation("fixed-window", error);
    return { allowed: true, retryAfterSeconds: 0 };
  }
};

/**
 * The same window, decided the other way round.
 *
 * `unavailable` is a THIRD outcome rather than a second flavour of `throttled`, because the caller
 * has to be able to answer the two differently: an over-limit request is the operator's own doing
 * and gets a 429 with a wait, while an unreachable Redis is the platform's fault and gets a 503.
 * Collapsing them would tell an operator to wait sixty seconds for a condition that waiting does
 * not clear.
 */
export type FixedWindowDecision =
  | { decision: "allowed" }
  | { decision: "throttled"; retryAfterSeconds: number }
  | { decision: "unavailable" };

/**
 * Fixed-window request limiter, FAIL-CLOSED: an unreachable or unconfigured Redis REFUSES.
 *
 * This exists as a separate function rather than a flag on `checkFixedWindowLimit` because the
 * failure direction is the entire security property, and a boolean argument at a call site is the
 * easiest thing in the world to pass wrongly or to flip during a later edit. Two names, each of
 * which states what it does when Redis is gone.
 *
 * Fail-closed is correct only where refusing is the safe answer — the operational surfaces, under
 * the same asymmetry DEC-0112 applies to role reads and DEC-0134 to MFA. It must NOT be swapped in
 * on the self-service auth paths: there, refusing everyone is the harm.
 *
 * An unconfigured Redis is treated identically to an unreachable one. There is no "feature off"
 * reading available to a fail-closed limiter: a limiter that cannot count has not established that
 * the request is under the limit, and saying otherwise is exactly the lie this shape exists to
 * refuse.
 */
export const checkFixedWindowLimitFailClosed = async (
  params: FixedWindowParams,
): Promise<FixedWindowDecision> => {
  if (!serverEnv.redisUrl) {
    return { decision: "unavailable" };
  }

  try {
    const result = await runFixedWindow(params);
    return result.allowed
      ? { decision: "allowed" }
      : { decision: "throttled", retryAfterSeconds: result.retryAfterSeconds };
  } catch (error) {
    reportRedisDegradation("fixed-window-fail-closed", error);
    return { decision: "unavailable" };
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

// Lua script for an atomic "read the value, then delete the key" — Redis GETDEL (6.2+) expressed
// portably, since this project's target Redis version is not pinned. A plain GET-then-DEL from the
// client has a window where two concurrent callers can both read the value before either deletes
// it, which defeats single-use; EVAL runs the whole thing as one atomic operation on the server.
const GET_AND_DELETE_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

// Stores a single-use, short-lived grant: `key` maps to `value` for `ttlSeconds`, then expires on
// its own if never consumed. Fail-CLOSED, matching consumeSingleUseToken: this backs the MFA
// elevation grant (server/auth/mfa/mfa-elevation.ts), and if the grant cannot be POSITIVELY
// confirmed stored, the caller must not tell the operator they are one step from being elevated —
// the operation is refused and the challenge can be retried.
export const issueStoredGrant = async (params: {
  key: string;
  value: string;
  ttlSeconds: number;
}): Promise<void> => {
  if (!serverEnv.redisUrl) {
    throw new Error("stored-grant issue unavailable: REDIS_URL not configured");
  }

  try {
    await runRedisCommand(async (redis) => {
      await redis.set(params.key, params.value, "EX", Math.max(1, params.ttlSeconds));
    });
  } catch (error) {
    reportRedisDegradation("stored-grant-issue", error);
    throw error;
  }
};

// Atomically reads and deletes a grant written by issueStoredGrant. Returns the stored value on
// first consume, or null when the key never existed or was already consumed (replay). Fail-CLOSED:
// a Redis error here must not be read as "grant valid" or "grant invalid" — it is reported and
// re-thrown so the caller refuses the elevation outright.
export const consumeStoredGrant = async (key: string): Promise<string | null> => {
  if (!serverEnv.redisUrl) {
    throw new Error("stored-grant consume unavailable: REDIS_URL not configured");
  }

  try {
    return await runRedisCommand(async (redis) => {
      const result = await redis.eval(GET_AND_DELETE_SCRIPT, 1, key);
      return typeof result === "string" ? result : null;
    });
  } catch (error) {
    reportRedisDegradation("stored-grant-consume", error);
    throw error;
  }
};
