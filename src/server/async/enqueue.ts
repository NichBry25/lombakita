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

// Idempotency key: registrationId — deduplicates repeated confirmed events for the same row.
// Fire-and-forget — callers must catch errors.
export const enqueueRegistrationConfirmed = async (input: {
  registrationId: string;
  studentId: string;
  competitionId: string;
  registrationType: "individual" | "team";
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.registrationConfirmed>> => {
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.registrationConfirmed,
    idempotencyKey: input.registrationId,
    payload: {
      registrationId: input.registrationId,
      studentId: input.studentId,
      competitionId: input.competitionId,
      registrationType: input.registrationType,
    },
  });
};

// Idempotency key: registrationId — one cancellation email per registration row.
// Fire-and-forget — callers must catch errors.
export const enqueueRegistrationCancelled = async (input: {
  registrationId: string;
  studentId: string;
  competitionId: string;
  registrationType: "individual" | "team";
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.registrationCancelled>> => {
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.registrationCancelled,
    idempotencyKey: input.registrationId,
    payload: {
      registrationId: input.registrationId,
      studentId: input.studentId,
      competitionId: input.competitionId,
      registrationType: input.registrationType,
    },
  });
};

// Idempotency key: registrationId — one finalization email per submission (UNIQUE on registrationId).
// Fire-and-forget — callers must catch errors.
export const enqueueSubmissionFinalized = async (input: {
  submissionId: string;
  registrationId: string;
  studentId: string;
  competitionId: string;
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.submissionFinalized>> => {
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.submissionFinalized,
    idempotencyKey: input.registrationId,
    payload: {
      submissionId: input.submissionId,
      registrationId: input.registrationId,
      studentId: input.studentId,
      competitionId: input.competitionId,
    },
  });
};

// Step 6.5f — competition edited fan-out. Idempotency key includes the edit epoch (DEC-0081):
// job id `competition.edited__{competitionId}__{epoch}`. Each genuine edit (distinct epoch) is a
// fresh job that fires; a true same-epoch double-enqueue dedups. The worker re-derives recipients
// from current DB state. Fire-and-forget — callers must catch errors.
export const enqueueCompetitionEdited = async (input: {
  competitionId: string;
  changedFields: string[];
  epoch: number;
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.competitionEdited>> => {
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.competitionEdited,
    idempotencyKey: `${input.competitionId}__${input.epoch}`,
    payload: {
      competitionId: input.competitionId,
      changedFields: input.changedFields,
      epoch: input.epoch,
    },
  });
};

// Idempotency key includes the unpublish epoch (DEC-0081): job id
// `competition.cancelled__{competitionId}__{epoch}`. Fire-and-forget — callers must catch errors.
export const enqueueCompetitionCancelled = async (input: {
  competitionId: string;
  epoch: number;
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.competitionCancelled>> => {
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.competitionCancelled,
    idempotencyKey: `${input.competitionId}__${input.epoch}`,
    payload: {
      competitionId: input.competitionId,
      epoch: input.epoch,
    },
  });
};

// Step 6.5e — queued invite send (dual-channel). Idempotency key: invitationId, so a re-invite
// (which creates a NEW invitation row + id) is a distinct job while a double-enqueue of the same
// invitation dedups. Fire-and-forget from the invite-creation path — callers MUST catch errors so
// an enqueue failure never blocks invite creation (the in-app inbox entry is already live via
// target_user_id; the email is the second channel).
export const enqueueInstitutionInvitationDispatch = async (input: {
  invitationId: string;
  rawToken: string;
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.institutionInvitationDispatch>> => {
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.institutionInvitationDispatch,
    idempotencyKey: input.invitationId,
    payload: {
      invitationId: input.invitationId,
      rawToken: input.rawToken,
    },
  });
};

export const enqueueTeamInvitationDispatch = async (input: {
  invitationId: string;
  rawToken: string;
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.teamInvitationDispatch>> => {
  return enqueueAsyncJob({
    jobName: ASYNC_JOB_NAMES.teamInvitationDispatch,
    idempotencyKey: input.invitationId,
    payload: {
      invitationId: input.invitationId,
      rawToken: input.rawToken,
    },
  });
};

// Idempotency key: includes the publish-event timestamp so each genuine publish (including an
// unpublish→republish) is a distinct job that fires, while a true double-enqueue of the SAME
// publish event dedups on the identical timestamp. Base: registrationId for individual,
// {competitionId}__{teamId} for team; suffixed with __{publishedAtEpoch}.
// Fire-and-forget from the publish path — callers must catch errors.
export const enqueueResultPublished = async (input: {
  registrationId: string;
  competitionId: string;
  teamId?: string;
  publishedAt: Date;
}): Promise<EnqueueAsyncJobResult<typeof ASYNC_JOB_NAMES.resultPublished>> => {
  const base = input.teamId ? `${input.competitionId}__${input.teamId}` : input.registrationId;
  const idempotencyKey = `${base}__${input.publishedAt.getTime()}`;
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
