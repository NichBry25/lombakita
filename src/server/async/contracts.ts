import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/contracts");

export const ASYNC_QUEUE_NAMES = {
  infrastructure: "infrastructure",
  competition: "competition",
  results: "results",
  notifications: "notifications",
} as const;

export type AsyncQueueName = (typeof ASYNC_QUEUE_NAMES)[keyof typeof ASYNC_QUEUE_NAMES];

export const ASYNC_JOB_NAMES = {
  probePing: "infrastructure.probe.ping",
  competitionSearchSync: "competition.search.sync",
  resultPublished: "result.published",
  registrationConfirmed: "registration.confirmed",
  registrationCancelled: "registration.cancelled",
  submissionFinalized: "submission.finalized",
} as const;

export type AsyncJobName = (typeof ASYNC_JOB_NAMES)[keyof typeof ASYNC_JOB_NAMES];

export type AsyncProbeJobPayload = {
  probeId: string;
  requestedAt: string;
  triggeredBy: "script";
};

export type CompetitionSearchSyncPayload = {
  competitionId: string;
  action: "upsert" | "remove";
};

// Step 5.3 — notification trigger for published results.
// Worker activated at Step 6.1.
export type ResultPublishedPayload = {
  registrationId: string;
  competitionId: string;
  teamId?: string;
};

// Step 6.1 — transactional notification payloads.
// Workers do DB lookups for recipient email and competition title at dispatch time.
export type RegistrationConfirmedPayload = {
  registrationId: string;
  studentId: string;
  competitionId: string;
  registrationType: "individual" | "team";
};

export type RegistrationCancelledPayload = {
  registrationId: string;
  studentId: string;
  competitionId: string;
  registrationType: "individual" | "team";
};

export type SubmissionFinalizedPayload = {
  submissionId: string;
  registrationId: string;
  studentId: string;
  competitionId: string;
};

export type AsyncJobPayloadByName = {
  [ASYNC_JOB_NAMES.probePing]: AsyncProbeJobPayload;
  [ASYNC_JOB_NAMES.competitionSearchSync]: CompetitionSearchSyncPayload;
  [ASYNC_JOB_NAMES.resultPublished]: ResultPublishedPayload;
  [ASYNC_JOB_NAMES.registrationConfirmed]: RegistrationConfirmedPayload;
  [ASYNC_JOB_NAMES.registrationCancelled]: RegistrationCancelledPayload;
  [ASYNC_JOB_NAMES.submissionFinalized]: SubmissionFinalizedPayload;
};

export const ASYNC_JOB_QUEUE_BY_NAME = {
  [ASYNC_JOB_NAMES.probePing]: ASYNC_QUEUE_NAMES.infrastructure,
  [ASYNC_JOB_NAMES.competitionSearchSync]: ASYNC_QUEUE_NAMES.competition,
  [ASYNC_JOB_NAMES.resultPublished]: ASYNC_QUEUE_NAMES.results,
  [ASYNC_JOB_NAMES.registrationConfirmed]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.registrationCancelled]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.submissionFinalized]: ASYNC_QUEUE_NAMES.notifications,
} as const satisfies Record<AsyncJobName, AsyncQueueName>;
