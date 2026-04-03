import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/redis/client");

import Redis from "ioredis";
import { serverEnv } from "@/config/env.server";

declare global {
  var __lombakitaRedis: Redis | undefined;
}

const requireRedisUrl = (): string => {
  if (!serverEnv.redisUrl) {
    throw new Error("REDIS_URL is not configured");
  }

  return serverEnv.redisUrl;
};

const createRedisClient = (): Redis => {
  return new Redis(requireRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  });
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
