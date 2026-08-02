// In-app notification type catalogue.
//
// These string values are persisted in `notifications.type` (free-text column, validated here at
// the application layer rather than via a DB enum so new participant-facing event types can ship
// without a destructive enum migration). They use snake_case and are distinct from the BullMQ job
// names in `@/server/async/contracts` (which use dot.case, e.g. `registration.confirmed`): the job
// name identifies the queue message, this type identifies the stored inbox row.
//
// Pure constants/types only — no server-only or DB imports — so it is safe to import from the
// inbox render layer as well as the worker dual-write path.

export const NOTIFICATION_TYPES = {
  registrationConfirmed: "registration_confirmed",
  registrationCancelled: "registration_cancelled",
  submissionFinalized: "submission_finalized",
  resultPublished: "result_published",
  competitionEdited: "competition_edited",
  competitionCancelled: "competition_cancelled",
  recruiterVerificationRejected: "recruiter_verification_rejected",
  registrationDocumentRequested: "registration_document_requested",
  registrationDocumentReviewed: "registration_document_reviewed",
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export const NOTIFICATION_TYPE_VALUES = Object.values(NOTIFICATION_TYPES) as NotificationType[];

export const isNotificationType = (value: string): value is NotificationType => {
  return (NOTIFICATION_TYPE_VALUES as string[]).includes(value);
};
