import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import type { InstitutionInvitationStatus, InstitutionMembershipRole } from "@/server/db/schema";

export const INVITATION_EXPIRY_DAYS = 7;

// Roles that can be targeted by the institution invitation flow (Step 1.4 / DEC-0043).
const INVITATION_TARGET_ROLES: readonly InstitutionMembershipRole[] = [
  "institution_owner",
  "institution_staff",
  "institution_member",
];

// Roles whose invites require recruiter verification on the accepting account (CCR-08 / DEC-0042).
// institution_member invites accept any verified account (candidate_verified OR recruiter_verified).
export const RECRUITER_VERIFIED_ROLES: readonly InstitutionMembershipRole[] = [
  "institution_owner",
  "institution_staff",
];

export type InstitutionInvitationMeta = {
  id: string;
  institutionId: string;
  institutionDisplayName: string;
  invitedEmail: string;
  invitedRole: InstitutionMembershipRole;
  status: InstitutionInvitationStatus;
  expiresAt: Date;
  createdAt: Date;
};

export type InvitationCreateInput = {
  // Step 6.5e — a username OR an email. Classified + resolved in the service via
  // `resolveInviteRecipient`. Kept as a raw (trimmed) string here so the core stays db-free.
  invitedIdentifier: string;
  invitedRole: InstitutionMembershipRole;
};

type InstitutionInvitationErrorCode =
  | "invitation_invalid_payload"
  | "invitation_invalid_identifier"
  | "invitation_invalid_role"
  | "invitation_recipient_not_found"
  | "invitation_already_pending"
  | "invitation_not_found"
  | "invitation_not_actionable"
  | "invitation_already_member"
  | "invitation_forbidden"
  | "invitation_role_verification_required";

export class InstitutionInvitationError extends Error {
  constructor(
    public readonly code: InstitutionInvitationErrorCode,
    public readonly httpStatus: 400 | 403 | 404 | 409 | 410,
    message: string,
    public readonly redirectTo?: string,
  ) {
    super(message);
  }
}

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

  const { invitedIdentifier, invitedRole } = payload;

  // Step 6.5e — accept a username OR an email. Format-classification (and the email/username split)
  // happens in the service via `classifyInviteIdentifier`; here we only require a non-empty string.
  if (typeof invitedIdentifier !== "string" || invitedIdentifier.trim().length === 0) {
    throw new InstitutionInvitationError(
      "invitation_invalid_identifier",
      400,
      "invitedIdentifier (a username or email) is required",
    );
  }

  if (
    typeof invitedRole !== "string" ||
    !INVITATION_TARGET_ROLES.includes(invitedRole as InstitutionMembershipRole)
  ) {
    throw new InstitutionInvitationError(
      "invitation_invalid_role",
      400,
      `invitedRole must be one of: ${INVITATION_TARGET_ROLES.join(", ")}`,
    );
  }

  return {
    invitedIdentifier: invitedIdentifier.trim(),
    invitedRole: invitedRole as InstitutionMembershipRole,
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
    throw new InstitutionInvitationError("invitation_invalid_payload", 400, "token is required");
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
  const body: Record<string, unknown> = { code: error.code, message: error.message };
  if (error.redirectTo) body.redirectTo = error.redirectTo;
  return NextResponse.json({ error: body }, { status: error.httpStatus });
};
