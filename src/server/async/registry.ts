import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/registry");

import type { Job } from "bullmq";
import {
  ASYNC_JOB_NAMES,
  ASYNC_JOB_QUEUE_BY_NAME,
  type AsyncJobName,
  type AsyncJobPayloadByName,
  type AsyncQueueName,
} from "@/server/async/contracts";
import { processProbeJob } from "@/server/async/jobs/probe";
import { processCompetitionSearchSyncJob } from "@/server/async/jobs/competition-search-sync";
import { processResultPublishedJob } from "@/server/async/jobs/result-published";
import { processRegistrationConfirmedJob } from "@/server/async/jobs/registration-confirmed";
import { processRegistrationCancelledJob } from "@/server/async/jobs/registration-cancelled";
import { processSubmissionFinalizedJob } from "@/server/async/jobs/submission-finalized";
import { processCompetitionEditedJob } from "@/server/async/jobs/competition-edited";
import { processCompetitionCancelledJob } from "@/server/async/jobs/competition-cancelled";
import { processInstitutionInvitationDispatchJob } from "@/server/async/jobs/institution-invitation-dispatch";
import { processTeamInvitationDispatchJob } from "@/server/async/jobs/team-invitation-dispatch";
import { processRecruiterVerificationRejectedJob } from "@/server/async/jobs/recruiter-verification-rejected";

export type AsyncJobProcessor<Name extends AsyncJobName = AsyncJobName> = (
  job: Job<AsyncJobPayloadByName[Name], void, Name>,
) => Promise<void>;

export type AsyncJobRegistration<Name extends AsyncJobName = AsyncJobName> = {
  queueName: AsyncQueueName;
  jobName: Name;
  process: AsyncJobProcessor<Name>;
};

const defineAsyncJob = <Name extends AsyncJobName>(
  jobName: Name,
  process: AsyncJobProcessor<Name>,
): AsyncJobRegistration<Name> => {
  return {
    queueName: ASYNC_JOB_QUEUE_BY_NAME[jobName],
    jobName,
    process,
  };
};

export const ASYNC_JOB_REGISTRATIONS = [
  defineAsyncJob(ASYNC_JOB_NAMES.probePing, processProbeJob),
  defineAsyncJob(ASYNC_JOB_NAMES.competitionSearchSync, processCompetitionSearchSyncJob),
  defineAsyncJob(ASYNC_JOB_NAMES.resultPublished, processResultPublishedJob),
  defineAsyncJob(ASYNC_JOB_NAMES.registrationConfirmed, processRegistrationConfirmedJob),
  defineAsyncJob(ASYNC_JOB_NAMES.registrationCancelled, processRegistrationCancelledJob),
  defineAsyncJob(ASYNC_JOB_NAMES.submissionFinalized, processSubmissionFinalizedJob),
  defineAsyncJob(ASYNC_JOB_NAMES.competitionEdited, processCompetitionEditedJob),
  defineAsyncJob(ASYNC_JOB_NAMES.competitionCancelled, processCompetitionCancelledJob),
  defineAsyncJob(
    ASYNC_JOB_NAMES.institutionInvitationDispatch,
    processInstitutionInvitationDispatchJob,
  ),
  defineAsyncJob(ASYNC_JOB_NAMES.teamInvitationDispatch, processTeamInvitationDispatchJob),
  defineAsyncJob(
    ASYNC_JOB_NAMES.recruiterVerificationRejected,
    processRecruiterVerificationRejectedJob,
  ),
] as const;

const getUniqueQueueNames = (): AsyncQueueName[] => {
  return [...new Set(ASYNC_JOB_REGISTRATIONS.map((item) => item.queueName))];
};

export const getRegisteredQueueNames = (): AsyncQueueName[] => {
  return getUniqueQueueNames();
};

export const getQueueRegistrations = (queueName: AsyncQueueName): AsyncJobRegistration[] => {
  return ASYNC_JOB_REGISTRATIONS.filter(
    (item) => item.queueName === queueName,
  ) as AsyncJobRegistration[];
};

export const getRegistrationByJobName = (
  jobName: AsyncJobName,
): AsyncJobRegistration | undefined => {
  return ASYNC_JOB_REGISTRATIONS.find((item) => item.jobName === jobName) as
    | AsyncJobRegistration
    | undefined;
};
