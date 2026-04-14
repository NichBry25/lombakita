import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/queue");

import type Redis from "ioredis";
import { Queue } from "bullmq";
import { ASYNC_JOB_DEFAULT_OPTIONS } from "@/server/async/config";
import { type AsyncQueueName } from "@/server/async/contracts";
import { createBullmqRedisClient } from "@/server/redis/client";

declare global {
  var __lombakitaAsyncQueueRegistry: Map<AsyncQueueName, Queue> | undefined;
  var __lombakitaAsyncProducerRedis: Redis | undefined;
}

const getAsyncProducerRedis = (): Redis => {
  if (!globalThis.__lombakitaAsyncProducerRedis) {
    globalThis.__lombakitaAsyncProducerRedis = createBullmqRedisClient();
  }

  return globalThis.__lombakitaAsyncProducerRedis;
};

const createQueue = (queueName: AsyncQueueName): Queue => {
  return new Queue(queueName, {
    connection: getAsyncProducerRedis(),
    defaultJobOptions: ASYNC_JOB_DEFAULT_OPTIONS,
  });
};

export const getAsyncQueue = (queueName: AsyncQueueName): Queue => {
  if (!globalThis.__lombakitaAsyncQueueRegistry) {
    globalThis.__lombakitaAsyncQueueRegistry = new Map<AsyncQueueName, Queue>();
  }

  const existing = globalThis.__lombakitaAsyncQueueRegistry.get(queueName);
  if (existing) {
    return existing;
  }

  const queue = createQueue(queueName);
  globalThis.__lombakitaAsyncQueueRegistry.set(queueName, queue);

  return queue;
};

export const closeAsyncQueueConnections = async (): Promise<void> => {
  const queueRegistry = globalThis.__lombakitaAsyncQueueRegistry;

  if (queueRegistry) {
    await Promise.all([...queueRegistry.values()].map((queue) => queue.close()));
    queueRegistry.clear();
    globalThis.__lombakitaAsyncQueueRegistry = undefined;
  }

  if (globalThis.__lombakitaAsyncProducerRedis) {
    await globalThis.__lombakitaAsyncProducerRedis.quit();
    globalThis.__lombakitaAsyncProducerRedis = undefined;
  }
};
