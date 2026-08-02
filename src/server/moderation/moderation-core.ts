import { NextResponse } from "next/server";

// Shared error primitive for the platform ops moderation module (moderation, notes,
// lookup services). Mirrors the CompetitionError / FeaturedPlacementError pattern: a typed code +
// HTTP status that route handlers translate directly into a JSON error envelope.
export type ModerationErrorCode =
  | "reason_required"
  | "cannot_suspend_platform_ops"
  | "user_not_found"
  | "user_already_suspended"
  | "user_not_suspended"
  | "institution_not_found"
  | "institution_already_suspended"
  | "institution_not_suspended"
  | "invalid_note_target"
  | "note_required"
  | "note_not_found";

export class ModerationError extends Error {
  constructor(
    public readonly code: ModerationErrorCode,
    public readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ModerationError";
  }
}

export const toModerationErrorResponse = (error: ModerationError): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );

// Audit event type literals written to platform_ops_audit_logs. Centralised so the service layer
// and any future reader share one source of truth.
export const MODERATION_EVENT = {
  userSuspended: "user.suspended",
  userUnsuspended: "user.unsuspended",
  institutionSuspended: "institution.suspended",
  institutionReinstated: "institution.reinstated",
} as const;

// Non-empty-after-trim guard for the mandatory `reason` field on every moderation action.
export const assertReasonProvided = (reason: unknown): string => {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new ModerationError("reason_required", 400, "A reason is required for this action");
  }
  return reason.trim();
};
