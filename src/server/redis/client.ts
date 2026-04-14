import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/redis/client");

import Redis, { type RedisOptions } from "ioredis";
import { serverEnv } from "@/config/env.server";

declare global {
  var __lombakitaRedis: Redis | undefined;
}

const REDIS_CONNECT_TIMEOUT_MS = 3000;

export type RedisClientMode = "default" | "bullmq";

export const requireRedisUrl = (): string => {
  if (!serverEnv.redisUrl) {
    throw new Error("REDIS_URL is not configured");
  }

  return serverEnv.redisUrl;
};

export const getRedisClientOptions = (mode: RedisClientMode = "default"): RedisOptions => {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: mode === "bullmq" ? null : 1,
    enableOfflineQueue: false,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
  };
};

const createRedisClient = (): Redis => {
  return new Redis(requireRedisUrl(), getRedisClientOptions("default"));
};

export const createBullmqRedisClient = (): Redis => {
  return new Redis(requireRedisUrl(), getRedisClientOptions("bullmq"));
};

export const getRedisClient = (): Redis => {
  if (!globalThis.__lombakitaRedis) {
    globalThis.__lombakitaRedis = createRedisClient();
  }

  return globalThis.__lombakitaRedis;
};

export const closeRedisConnection = async (): Promise<void> => {
  if (!globalThis.__lombakitaRedis) {
    return;
  }

  await globalThis.__lombakitaRedis.quit();
  globalThis.__lombakitaRedis = undefined;
};
