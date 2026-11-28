import { NextResponse } from "next/server";
import type { InstitutionVerificationStatus } from "@/server/db/schema";

export type VerificationTransition = {
  from: InstitutionVerificationStatus;
  to: InstitutionVerificationStatus;
};

type VerificationErrorCode =
  | "verification_invalid_transition"
  // The transition was legal when it was read, but another actor moved the institution before this
  // one committed. Distinct from an invalid transition: the request was well-formed and the caller
  // should re-read and decide again, not correct their input.
  | "verification_transition_conflict"
  | "verification_not_found"
  | "verification_reason_required"
  | "verification_invalid_payload"
  // Shares its string with the SubmissionError of the same name: both mean "this institution
  // has no document verification to act on" and a client can branch on the one code.
  | "institution_verification_not_applicable"
  | "institution_tick_owner_trust_removed"
  | "institution_suspended"
  | "institution_already_verified"
  | "institution_tick_path_a_closed"
  | "institution_tick_live_paid_competition"
  | "institution_tick_no_organization_email"
  | "institution_tick_no_website"
  | "institution_tick_domain_mismatch"
  | "institution_tick_instagram_invalid"
  | "institution_tick_removal_unconfirmed"
  | "institution_name_check_not_applicable"
  | "institution_name_check_reason_required"
  | "institution_name_proof_running"
  | "institution_name_check_reason_invalid";

export class VerificationError extends Error {
  constructor(
    public readonly code: VerificationErrorCode,
    public readonly status: 404 | 409 | 422 | 400 | 403,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// The error envelope of a refusal. details is sent only when the refusal carries it, as the closure
// refusals carry their cause.
export const toVerificationErrorResponse = (error: VerificationError): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details } },
    { status: error.status },
  );

// Every status change an institution's verification may legally make, whichever path requests it —
// the platform_ops admin table (`verifyInstitution`) or the approval of a document submission
// (`reviewVerificationSubmission`). Any combination not listed here is a 409 Conflict.
//
// This set describes what is LEGAL, not what ops is offered. The admin table keeps its own narrower
// list of buttons (AVAILABLE_TRANSITIONS in app/admin/institutions/page.tsx), which is what holds
// ops to the review workflow — a direct pending_verification->verified is legal here because
// approving a submission does exactly that, but the admin table still only offers "Tinjau" first.
//
// No status is terminal. A verified institution can have its verification revoked (with a mandatory
// reason — see parseVerifyInput), and a rejected one can be re-opened or approved on a fresh
// submission. The audit trail is what distinguishes the two kinds of rejection: verified->rejected
// is a revocation, under_review->rejected is a denial.
//
// verified->pending_verification is deliberately absent. It is the automatic removal of a tick
// after a website change or an owner rename, and only removeTickAutomatically writes it, so no
// staff request can ask for it.
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set([
  "pending_verification->under_review",
  "pending_verification->rejected",
  "pending_verification->verified",
  "under_review->verified",
  "under_review->rejected",
  "rejected->under_review",
  "rejected->verified",
  "verified->rejected",
]);

const transitionKey = (
  from: InstitutionVerificationStatus,
  to: InstitutionVerificationStatus,
): string => `${from}->${to}`;

export const assertValidTransition = (
  from: InstitutionVerificationStatus,
  to: InstitutionVerificationStatus,
): void => {
  if (!ALLOWED_TRANSITIONS.has(transitionKey(from, to))) {
    throw new VerificationError(
      "verification_invalid_transition",
      409,
      `Cannot transition from '${from}' to '${to}'`,
    );
  }
};

export const VERIFICATION_STATUS_VALUES: readonly InstitutionVerificationStatus[] = [
  "pending_verification",
  "under_review",
  "verified",
  "rejected",
];

export const isVerificationStatus = (value: string): value is InstitutionVerificationStatus =>
  (VERIFICATION_STATUS_VALUES as readonly string[]).includes(value);

export type VerifyInput = {
  targetStatus: InstitutionVerificationStatus;
  reason?: string;
};

export const parseVerifyInput = (body: unknown): VerifyInput => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new VerificationError(
      "verification_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }

  const raw = body as Record<string, unknown>;
  const targetStatus = raw.targetStatus;

  if (typeof targetStatus !== "string" || !isVerificationStatus(targetStatus)) {
    throw new VerificationError(
      "verification_invalid_payload",
      400,
      `targetStatus must be one of: ${VERIFICATION_STATUS_VALUES.join(", ")}`,
    );
  }

  if (targetStatus === "rejected") {
    if (!raw.reason || typeof raw.reason !== "string" || raw.reason.trim().length === 0) {
      throw new VerificationError(
        "verification_reason_required",
        422,
        "reason is required when rejecting an institution",
      );
    }
    return { targetStatus, reason: raw.reason.trim() };
  }

  return { targetStatus };
};

// Absent means false. The only value that may be sent is the boolean true, so a client cannot
// confirm a tick removal with a value that merely looks truthy.
export const parseAcknowledgeTickRemoval = (value: unknown): boolean => {
  if (value === undefined) return false;
  if (value !== true) {
    throw new VerificationError(
      "verification_invalid_payload",
      400,
      "acknowledgeTickRemoval must be true when it is sent",
    );
  }
  return true;
};

const INSTAGRAM_HOSTS: ReadonlySet<string> = new Set(["instagram.com", "www.instagram.com"]);
const INSTAGRAM_HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

const instagramInvalid = (): VerificationError =>
  new VerificationError(
    "institution_tick_instagram_invalid",
    400,
    "instagramUrl must be the link of an Instagram profile",
  );

export const normalizeInstagramProfileUrl = (value: unknown): string => {
  if (typeof value !== "string") throw instagramInvalid();

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw instagramInvalid();
  }

  const hasCredentialsOrPort = url.username !== "" || url.password !== "" || url.port !== "";
  if (url.protocol !== "https:" || hasCredentialsOrPort || !INSTAGRAM_HOSTS.has(url.hostname)) {
    throw instagramInvalid();
  }

  const handle = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  if (!INSTAGRAM_HANDLE_PATTERN.test(handle)) throw instagramInvalid();

  return `https://www.instagram.com/${handle.toLowerCase()}/`;
};

export type VerificationSubmitBody =
  | { path: "documents"; documents: unknown }
  | { path: "instagram"; instagramUrl: string };

const invalidSubmitPayload = (message: string): VerificationError =>
  new VerificationError("verification_invalid_payload", 400, message);

export const parseVerificationSubmitBody = (body: unknown): VerificationSubmitBody => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidSubmitPayload("Request body must be a JSON object");
  }

  const raw = body as Record<string, unknown>;
  const path = raw.path === undefined ? "documents" : raw.path;

  if (path === "instagram") {
    return { path, instagramUrl: normalizeInstagramProfileUrl(raw.instagramUrl) };
  }

  if (path !== "documents") {
    throw invalidSubmitPayload("path must be one of: instagram, documents");
  }

  if (raw.instagramUrl !== undefined) {
    throw invalidSubmitPayload("instagramUrl is allowed only on an instagram request");
  }

  return { path, documents: raw.documents };
};
