import type { InstitutionVerificationStatus } from "@/server/db/schema";

export type VerificationTransition = {
  from: InstitutionVerificationStatus;
  to: InstitutionVerificationStatus;
};

type VerificationErrorCode =
  | "verification_invalid_transition"
  | "verification_not_found"
  | "verification_reason_required"
  | "verification_invalid_payload";

export class VerificationError extends Error {
  constructor(
    public readonly code: VerificationErrorCode,
    public readonly status: 404 | 409 | 422 | 400,
    message: string,
  ) {
    super(message);
  }
}

// All valid status transitions for platform_ops institution verification.
// Any combination not listed here is a 409 Conflict.
// verified and rejected are terminal — add transitions FROM them above if that ever changes.
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set([
  "pending_verification->under_review",
  "pending_verification->rejected",
  "under_review->verified",
  "under_review->rejected",
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
