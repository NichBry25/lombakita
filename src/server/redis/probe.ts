import { getRedisClient } from "@/server/redis/client";

export const isRedisConfigured = (): boolean => {
  return Boolean(process.env.REDIS_URL);
};

export const probeRedis = async (): Promise<void> => {
  const redis = getRedisClient();

  if (redis.status === "wait") {
    await redis.connect();
  }

  const response = await redis.ping();

  if (response !== "PONG") {
    throw new Error(`unexpected redis ping response: ${response}`);
  }
};
