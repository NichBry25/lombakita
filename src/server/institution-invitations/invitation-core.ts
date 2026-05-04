import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import type { InstitutionInvitationStatus } from "@/server/db/schema";

export const INVITATION_EXPIRY_DAYS = 7;
export const INVITATION_TARGET_ROLE = "institution_staff" as const;

export type InstitutionInvitationMeta = {
  id: string;
  institutionId: string;
  institutionDisplayName: string;
  invitedEmail: string;
  invitedRole: "institution_staff";
  status: InstitutionInvitationStatus;
  expiresAt: Date;
  createdAt: Date;
};

export type InvitationCreateInput = {
  invitedEmail: string;
  invitedRole: "institution_staff";
};

type InstitutionInvitationErrorCode =
  | "invitation_invalid_payload"
  | "invitation_invalid_email"
  | "invitation_invalid_role"
  | "invitation_already_pending"
  | "invitation_not_found"
  | "invitation_not_actionable"
  | "invitation_already_member"
  | "invitation_forbidden";

export class InstitutionInvitationError extends Error {
  constructor(
    public readonly code: InstitutionInvitationErrorCode,
    public readonly httpStatus: 400 | 403 | 404 | 409 | 410,
    message: string,
  ) {
    super(message);
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const parseInvitationCreateInput = (payload: unknown): InvitationCreateInput => {
  if (!isRecord(payload)) {
    throw new InstitutionInvitationError(
      "invitation_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }

  const { invitedEmail, invitedRole } = payload;

  if (typeof invitedEmail !== "string" || !EMAIL_PATTERN.test(invitedEmail.trim())) {
    throw new InstitutionInvitationError(
      "invitation_invalid_email",
      400,
      "invitedEmail must be a valid email address",
    );
  }

  if (invitedRole !== INVITATION_TARGET_ROLE) {
    throw new InstitutionInvitationError(
      "invitation_invalid_role",
      400,
      `invitedRole must be "${INVITATION_TARGET_ROLE}"`,
    );
  }

  return {
    invitedEmail: invitedEmail.trim().toLowerCase(),
    invitedRole: INVITATION_TARGET_ROLE,
  };
};

export const parseDeclineBody = (payload: unknown): { token: string } => {
  if (!isRecord(payload)) {
    throw new InstitutionInvitationError(
      "invitation_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }

  const { token } = payload;

  if (typeof token !== "string" || token.length === 0) {
    throw new InstitutionInvitationError(
      "invitation_invalid_payload",
      400,
      "token is required",
    );
  }

  return { token };
};

export const generateRawToken = (): string => {
  return randomBytes(32).toString("hex");
};

export const hashToken = (rawToken: string): string => {
  return createHash("sha256").update(rawToken).digest("hex");
};

// Only the first 8 chars are safe to include in logs — never the full raw token.
export const maskToken = (rawToken: string): string => {
  return `${rawToken.slice(0, 8)}…`;
};

export const buildInvitationExpiresAt = (from: Date = new Date()): Date => {
  const expiry = new Date(from);
  expiry.setDate(expiry.getDate() + INVITATION_EXPIRY_DAYS);
  return expiry;
};

export const toInstitutionInvitationErrorResponse = (
  error: InstitutionInvitationError,
): NextResponse => {
  return NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.httpStatus },
  );
};
