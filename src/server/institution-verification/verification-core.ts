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
  | "institution_verification_not_applicable";

export class VerificationError extends Error {
  constructor(
    public readonly code: VerificationErrorCode,
    public readonly status: 404 | 409 | 422 | 400,
    message: string,
  ) {
    super(message);
  }
}

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
