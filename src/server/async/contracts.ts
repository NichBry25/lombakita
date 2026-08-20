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
  competitionEdited: "competition.edited",
  competitionCancelled: "competition.cancelled",
  institutionInvitationDispatch: "institution.invitation.dispatch",
  teamInvitationDispatch: "team.invitation.dispatch",
  recruiterVerificationRejected: "recruiter.verification.rejected",
  registrationDocumentRequested: "registration.document.requested",
  registrationDocumentReviewed: "registration.document.reviewed",
  retentionPurge: "retention.purge",
  paymentExpirySweep: "payment.expiry.sweep",
  paymentProofSubmitted: "payment.proof.submitted",
  paymentOutcome: "payment.outcome",
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

// Notification trigger for published results.
export type ResultPublishedPayload = {
  registrationId: string;
  competitionId: string;
  teamId?: string;
};

// Transactional notification payloads.
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

// Competition lifecycle fan-out events. The worker re-derives all
// non-cancelled registrations for the competition at job-run time and writes one in-app
// notification row + one email per recipient (DEC-0076). `epoch` is the enqueue-time timestamp
// folded into the idempotency key (DEC-0081) so a genuine re-fire produces a fresh notification
// batch while a same-epoch double-enqueue dedups. `changedFields` carries the notify-bucket field
// names so the worker can summarise the change category without leaking old/new values.
export type CompetitionEditedPayload = {
  competitionId: string;
  changedFields: string[];
  epoch: number;
};

export type CompetitionCancelledPayload = {
  competitionId: string;
  epoch: number;
};

// Queued dual-channel invite send. The worker derives the email variant from the
// invitation's CURRENT status (pending → "you have an invite, open your inbox"; pending_claim →
// "create an account to accept", linking /auth/login?invite=<rawToken>). The raw token is carried
// here because only its SHA-256 hash is persisted; it grants no acceptance (acceptance is in-app,
// session-id matched) — its sole use is the claim-signup link's invited-email prefill.
export type InstitutionInvitationDispatchPayload = {
  invitationId: string;
  rawToken: string;
};

export type TeamInvitationDispatchPayload = {
  invitationId: string;
  rawToken: string;
};

// Recruiter trust verification rejected. The reason and the reopen decision are carried on the
// payload rather than re-read at job-run time: the recruiter may reopen the submission before the
// job runs, at which point the row no longer reflects the verdict this notification is about.
// `epoch` is the rejection timestamp folded into the idempotency key (DEC-0081) so each distinct
// rejection of the same submission produces its own notification.
export type RecruiterVerificationRejectedPayload = {
  submissionId: string;
  userId: string;
  rejectionReason: string;
  resubmissionAllowed: boolean;
  epoch: number;
};

// Participant document verification. Both payloads carry their content rather than a pointer, for
// the same reason the recruiter rejection does: by the time the worker runs the request may have
// been answered, extended, or reopened, and re-reading the row would announce the wrong thing.
// `epoch` folds the event timestamp into the idempotency key so a re-request or a second verdict on
// the same request each notify (DEC-0081).
export type RegistrationDocumentRequestedPayload = {
  requestId: string;
  userId: string;
  competitionTitle: string;
  institutionName: string;
  title: string;
  instructions: string | null;
  dueAtIso: string;
  epoch: number;
};

// A bukti transfer has arrived and needs a human to look at it. ORGANISER-ONLY (R13): the payer
// already knows they submitted it, and telling them again the moment they press the button is
// noise. Recipients are resolved at dispatch, not carried on the payload, so a staff member added
// between submission and delivery is still told.
export type PaymentProofSubmittedPayload = {
  paymentId: string;
  proofId: string;
  // WHICH attempt this is. A resubmission REUSES the proof row and bumps `resubmission_count`, so
  // the proof id alone is the same identity for every attempt and a second bukti transfer would be
  // swallowed as a replay of the first — leaving the organiser never told it arrived.
  attempt: number;
  competitionTitle: string;
  // Both slugs, so the email can link to the review queue itself. An organiser who administers
  // more than one institution cannot act on a link to `/institution`.
  institutionSlug: string;
  competitionSlug: string;
  institutionId: string;
  payerDisplayName: string;
  grossAmount: number;
  currency: string;
};

// What became of the money, told to EVERY member of the payment group (R13). A team pays once and
// a verdict on that payment decides whether the whole team is still entered.
//
// `expired` is the outcome with no human behind it. Its copy must not read as an organiser
// decision — nobody rejected anyone, a deadline passed — which is the same reasoning that put
// "secara otomatis" in the candidate panel's expired notice.
export type PaymentOutcomePayload = {
  paymentId: string;
  registrationId: string;
  // Same reason as the submission payload: reject → resubmit → reject is two distinct verdicts on
  // one payment, and without the attempt the second one is deduplicated away.
  //
  // LOAD-BEARING for `verified` and `rejected`, INERT for `expired` — a payment expires once, so
  // that arm always carries whatever the live proof happens to hold (0 when none was ever filed).
  // Stated because the next reader sees a constant on the expiry path and concludes the field can
  // be dropped, which silently re-collapses the two verdict identities.
  attempt: number;
  competitionTitle: string;
  outcome: "verified" | "rejected" | "expired";
  // Present only for `rejected`, and only when the organiser gave one.
  rejectionReason: string | null;
  // Present only for `rejected`: whether the candidate may send new evidence.
  resubmissionAllowed: boolean | null;
  grossAmount: number;
  currency: string;
};

export type RegistrationDocumentReviewedPayload = {
  requestId: string;
  userId: string;
  competitionTitle: string;
  title: string;
  outcome: "accepted" | "rejected" | "revision_requested";
  reviewNote: string | null;
  // Present only when the rejection reopened the request for another attempt.
  dueAtIso: string | null;
  epoch: number;
};

// The only job in the system that is not triggered by a request — it fires on a timer (see
// `retention-scheduler.ts`). Retention is time-based by nature: nothing a user does marks a
// competition's files as due, only the calendar passing its event date does. The payload carries
// the fire time purely so a run can be correlated in logs; the job reads the due list itself.
export type RetentionPurgePayload = {
  scheduledFor: string;
};

// The second job in the system that no request triggers. A payment deadline lapsing is a fact about
// the calendar, not an action anyone takes, and the candidate who needs telling is precisely the one
// not looking at the page — so it cannot be derived lazily at read time. The payload carries the
// fire time only for log correlation; the sweep reads the overdue list itself.
export type PaymentExpirySweepPayload = {
  scheduledFor: string;
};

export type AsyncJobPayloadByName = {
  [ASYNC_JOB_NAMES.probePing]: AsyncProbeJobPayload;
  [ASYNC_JOB_NAMES.competitionSearchSync]: CompetitionSearchSyncPayload;
  [ASYNC_JOB_NAMES.resultPublished]: ResultPublishedPayload;
  [ASYNC_JOB_NAMES.registrationConfirmed]: RegistrationConfirmedPayload;
  [ASYNC_JOB_NAMES.registrationCancelled]: RegistrationCancelledPayload;
  [ASYNC_JOB_NAMES.submissionFinalized]: SubmissionFinalizedPayload;
  [ASYNC_JOB_NAMES.competitionEdited]: CompetitionEditedPayload;
  [ASYNC_JOB_NAMES.competitionCancelled]: CompetitionCancelledPayload;
  [ASYNC_JOB_NAMES.institutionInvitationDispatch]: InstitutionInvitationDispatchPayload;
  [ASYNC_JOB_NAMES.teamInvitationDispatch]: TeamInvitationDispatchPayload;
  [ASYNC_JOB_NAMES.recruiterVerificationRejected]: RecruiterVerificationRejectedPayload;
  [ASYNC_JOB_NAMES.registrationDocumentRequested]: RegistrationDocumentRequestedPayload;
  [ASYNC_JOB_NAMES.registrationDocumentReviewed]: RegistrationDocumentReviewedPayload;
  [ASYNC_JOB_NAMES.retentionPurge]: RetentionPurgePayload;
  [ASYNC_JOB_NAMES.paymentExpirySweep]: PaymentExpirySweepPayload;
  [ASYNC_JOB_NAMES.paymentProofSubmitted]: PaymentProofSubmittedPayload;
  [ASYNC_JOB_NAMES.paymentOutcome]: PaymentOutcomePayload;
};

export const ASYNC_JOB_QUEUE_BY_NAME = {
  [ASYNC_JOB_NAMES.probePing]: ASYNC_QUEUE_NAMES.infrastructure,
  [ASYNC_JOB_NAMES.competitionSearchSync]: ASYNC_QUEUE_NAMES.competition,
  [ASYNC_JOB_NAMES.resultPublished]: ASYNC_QUEUE_NAMES.results,
  [ASYNC_JOB_NAMES.registrationConfirmed]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.registrationCancelled]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.submissionFinalized]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.competitionEdited]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.competitionCancelled]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.institutionInvitationDispatch]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.teamInvitationDispatch]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.recruiterVerificationRejected]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.registrationDocumentRequested]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.registrationDocumentReviewed]: ASYNC_QUEUE_NAMES.notifications,
  // Platform maintenance, not a participant-facing event — so it sits on `infrastructure`, away
  // from the notification queue whose backlog matters to users.
  [ASYNC_JOB_NAMES.retentionPurge]: ASYNC_QUEUE_NAMES.infrastructure,
  // Platform maintenance on the same reasoning as the retention sweep: the sweep itself is not
  // participant-facing, so it stays off the notification queue whose backlog users feel. The
  // notifications it causes are enqueued separately, as ordinary participant events.
  [ASYNC_JOB_NAMES.paymentExpirySweep]: ASYNC_QUEUE_NAMES.infrastructure,
  // Participant-facing, so both sit on the notifications queue — including the one the expiry
  // sweep causes, which is exactly what the note above means by "enqueued separately".
  [ASYNC_JOB_NAMES.paymentProofSubmitted]: ASYNC_QUEUE_NAMES.notifications,
  [ASYNC_JOB_NAMES.paymentOutcome]: ASYNC_QUEUE_NAMES.notifications,
} as const satisfies Record<AsyncJobName, AsyncQueueName>;
