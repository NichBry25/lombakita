import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/enqueue");

import {
  ASYNC_JOB_NAMES,
  ASYNC_JOB_QUEUE_BY_NAME,
  type AsyncJobName,
  type AsyncJobPayloadByName,
} from "@/server/async/contracts";
import { buildAsyncJobId, sanitizeIdempotencyKey } from "@/server/async/idempotency";
import { logEnqueueAccepted, logEnqueueRequested } from "@/server/async/observability";
import { getAsyncQueue } from "@/server/async/queue";

export type EnqueueAsyncJobInput<Name extends AsyncJobName> = {
  jobName: Name;
  payload: AsyncJobPayloadByName[Name];
  idempotencyKey: string;
};

export type EnqueueAsyncJobResult<Name extends AsyncJobName> = {
  queueName: (typeof ASYNC_JOB_QUEUE_BY_NAME)[Name];
  jobName: Name;
  jobId: string;
  idempotencyKey: string;
  duplicate: boolean;
};

export const enqueueAsyncJob = async <Name extends AsyncJobName>(
  input: EnqueueAsyncJobInput<Name>,
): Promise<EnqueueAsyncJobResult<Name>> => {
  const { jobName, payload } = input;
  const idempotencyKey = sanitizeIdempotencyKey(input.idempotencyKey);
  const queueName = ASYNC_JOB_QUEUE_BY_NAME[jobName];
  const jobId = buildAsyncJobId(jobName, idempotencyKey);
  const queue = getAsyncQueue(queueName);

  const existingJob = await queue.getJob(jobId);
  const duplicate = Boolean(existingJob);

  logEnqueueRequested({
    queueName,
    jobName,
    jobId,
    idempotencyKey,
    duplicate,
  });

  const acceptedJob = await queue.add(jobName, payload, {
    jobId,
  });

  logEnqueueAccepted({
    queueName,
    jobName,
    jobId,
    idempotencyKey,
    duplicate,
  });

  return {
    queueName,
    jobName,
    jobId: acceptedJob.id ?? jobId,
    idempotencyKey,
    duplicate,
  };
};

export const enqueueProbeJob = async (input: {
  probeId: string;
  triggeredBy: "script";
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.probePing>> => {
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.probePing,
    idempotencyKey: input.probeId,
    payload: {
      probeId: input.probeId,
      requestedAt: new Date().toISOString(),
      triggeredBy: input.triggeredBy,
    },
  });
};

// Idempotency key: {competitionId}:{action} — deduplicates rapid same-action enqueues
// for the same competition within the BullMQ job retention window.
export const enqueueCompetitionSearchSync = async (input: {
  competitionId: string;
  action: "upsert" | "remove";
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.competitionSearchSync>> => {
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.competitionSearchSync,
    idempotencyKey: `${input.competitionId}:${input.action}`,
    payload: {
      competitionId: input.competitionId,
      action: input.action,
    },
  });
};

// Idempotency key: registrationId for individual; {competitionId}__{teamId} for team.
// Fire-and-forget from the publish path — callers must catch errors.
export const enqueueResultPublished = async (input: {
  registrationId: string;
  competitionId: string;
  teamId?: string;
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.resultPublished>> => {
  const idempotencyKey = input.teamId
    ? `${input.competitionId}__${input.teamId}`
    : input.registrationId;
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.resultPublished,
    idempotencyKey,
    payload: {
      registrationId: input.registrationId,
      competitionId: input.competitionId,
      ...(input.teamId ? { teamId: input.teamId } : {}),
    },
  });
};
