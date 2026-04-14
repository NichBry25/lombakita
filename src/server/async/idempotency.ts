import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/idempotency");

import type { AsyncJobName } from "@/server/async/contracts";

const MAX_IDEMPOTENCY_KEY_LENGTH = 80;

export const sanitizeIdempotencyKey = (rawKey: string): string => {
  const trimmed = rawKey.trim();

  if (!trimmed) {
    throw new Error("idempotency key must not be empty");
  }

  const safeKey = trimmed.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);

  if (!safeKey) {
    throw new Error("idempotency key must contain at least one supported character");
  }

  return safeKey;
};

export const buildAsyncJobId = (jobName: AsyncJobName, idempotencyKey: string): string => {
  return `${jobName}__${sanitizeIdempotencyKey(idempotencyKey)}`;
};
