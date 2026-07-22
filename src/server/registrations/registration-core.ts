import { NextResponse } from "next/server";
import type {
  CompetitionRegistrationStatus,
  CompetitionRegistrationType,
} from "@/server/db/schema";

// Step 4.2 — Individual competition registration error codes.
// Each code maps to a specific failure case in the create/cancel/read enforcement chain.
// Phase 7: pending_payment state — not reachable in MVP. The state machine and enum carry the
// value but no error code references it; create() short-circuits to confirmed.
export type RegistrationErrorCode =
  | "registration_invalid_payload"
  | "competition_not_found"
  | "competition_not_published"
  | "competition_wrong_mode"
  | "registration_deadline_passed"
  | "registration_already_exists"
  | "registration_not_found"
  | "registration_not_owner"
  | "registration_wrong_status"
  // Step 6.5f / F12 — candidate cancellation policy gates.
  | "cancellation_reason_required"
  | "cancellation_reason_too_long"
  | "cancellation_not_supported_for_paid"
  | "cancellation_disabled_by_institution"
  | "cancellation_window_closed";

const STATUS_BY_CODE: Record<RegistrationErrorCode, number> = {
  registration_invalid_payload: 400,
  competition_not_found: 404,
  competition_not_published: 409,
  competition_wrong_mode: 409,
  registration_deadline_passed: 409,
  registration_already_exists: 409,
  registration_not_found: 404,
  registration_not_owner: 403,
  registration_wrong_status: 409,
  cancellation_reason_required: 422,
  cancellation_reason_too_long: 422,
  cancellation_not_supported_for_paid: 422,
  cancellation_disabled_by_institution: 422,
  cancellation_window_closed: 422,
};

export const MAX_CANCELLATION_REASON_LENGTH = 500;

export class RegistrationError extends Error {
  constructor(
    public readonly code: RegistrationErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export const toRegistrationErrorResponse = (error: RegistrationError): NextResponse => {
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? {},
      },
    },
    { status: error.status },
  );
};

// Wire-format registration record returned by every endpoint.
export type RegistrationRecord = {
  id: string;
  competitionId: string;
  studentId: string;
  registrationType: CompetitionRegistrationType;
  status: CompetitionRegistrationStatus;
  registeredAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

// Cancel-payload parser. Performs STRUCTURAL validation only (object shape, string type, no
// unknown keys) and returns the trimmed reason or null. The required-and-length business rules
// (F12) are enforced in the cancelRegistration service AFTER the ownership and status gates so the
// documented check order holds (a non-owner never sees a reason-validation error).
export const parseCancelPayload = (payload: unknown): { cancellationReason: string | null } => {
  if (payload === undefined || payload === null) {
    return { cancellationReason: null };
  }

  if (!isRecord(payload)) {
    throw new RegistrationError(
      "registration_invalid_payload",
      "Cancellation payload must be a JSON object",
    );
  }

  const allowedKeys = new Set(["cancellationReason"]);
  const unknownKeys = Object.keys(payload).filter((key) => !allowedKeys.has(key));

  if (unknownKeys.length > 0) {
    throw new RegistrationError(
      "registration_invalid_payload",
      "Cancellation payload contains unsupported fields",
      { fields: unknownKeys },
    );
  }

  if (!("cancellationReason" in payload) || payload.cancellationReason === null) {
    return { cancellationReason: null };
  }

  if (typeof payload.cancellationReason !== "string") {
    throw new RegistrationError(
      "registration_invalid_payload",
      "cancellationReason must be a string",
    );
  }

  const trimmed = payload.cancellationReason.trim();
  return { cancellationReason: trimmed.length === 0 ? null : trimmed };
};
