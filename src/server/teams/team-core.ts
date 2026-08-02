import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import type {
  TeamInvitationStatus,
  TeamMembershipRole,
  TeamMembershipStatus,
  TeamStatus,
} from "@/server/db/schema";

// Team invitation expiry. Matches institution_invitations cadence (7 days from
// creation). Acceptable at MVP; revisit if business requires shorter-lived team invites.
export const TEAM_INVITATION_EXPIRY_DAYS = 7;

// Team name validation. Length is generous for Indonesian team names; trimmed at the boundary.
const TEAM_NAME_MIN = 2;
const TEAM_NAME_MAX = 80;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

// Error codes are namespaced under `team_*` so callers can route on prefix.
// The submission/cancellation codes are returned with the same
// `details` envelope as the rest of the team error surface.
export type TeamErrorCode =
  | "team_invalid_payload"
  | "team_invalid_name"
  | "team_invalid_identifier"
  | "team_invite_recipient_not_found"
  | "team_competition_not_found"
  | "team_competition_not_published"
  | "team_competition_mode_not_allowed"
  | "team_competition_registration_closed"
  | "team_not_found"
  | "team_not_forming"
  | "team_name_taken"
  | "team_candidate_already_member"
  | "team_at_capacity"
  | "team_invite_already_pending"
  | "team_invite_not_found"
  | "team_invite_not_actionable"
  | "team_invite_account_not_found"
  | "team_invite_email_mismatch"
  // The accepting (target) account must be candidate-verified; team membership is
  // candidate-scoped. Non-leaking 403 enforced at the accept mutation.
  | "team_invite_candidate_required"
  | "team_membership_not_found"
  | "team_captain_cannot_leave"
  | "team_not_captain"
  | "team_member_not_in_team"
  | "team_forbidden"
  // Team registration submission and cancellation.
  | "team_registration_not_allowed"
  | "registration_window_closed"
  | "registration_not_yet_open"
  | "team_size_insufficient"
  | "team_size_exceeded"
  | "team_member_already_registered"
  | "team_not_submitted"
  | "team_state_conflict"
  // Candidate-cancellation policy applied to the captain's team cancellation.
  // Same code strings as the individual cancel path (registration-core) for client parity.
  | "cancellation_reason_required"
  | "cancellation_reason_too_long"
  | "cancellation_not_supported_for_paid"
  | "cancellation_disabled_by_institution"
  | "cancellation_window_closed"
  // Schema-invariant violation backstop — fires only if a code path writes a row that
  // violates `competition_registrations_type_team_id_chk` (registration_type + team_id
  // co-presence). All current code paths write the pair atomically, so this is a
  // defense-in-depth code that surfaces a typed 422 instead of a raw 500.
  | "team_registration_invariant_violation";

const STATUS_BY_CODE: Record<TeamErrorCode, number> = {
  team_invalid_payload: 400,
  team_invalid_name: 400,
  team_invalid_identifier: 400,
  team_invite_recipient_not_found: 404,
  team_competition_not_found: 404,
  team_competition_not_published: 422,
  team_competition_mode_not_allowed: 422,
  team_competition_registration_closed: 422,
  team_not_found: 404,
  team_not_forming: 409,
  team_name_taken: 409,
  team_candidate_already_member: 409,
  team_at_capacity: 422,
  team_invite_already_pending: 409,
  team_invite_not_found: 404,
  team_invite_not_actionable: 410,
  team_invite_account_not_found: 404,
  team_invite_email_mismatch: 403,
  team_invite_candidate_required: 403,
  team_membership_not_found: 404,
  team_captain_cannot_leave: 422,
  team_not_captain: 403,
  team_member_not_in_team: 404,
  team_forbidden: 403,
  // Submission/cancellation gates.
  team_registration_not_allowed: 422,
  registration_window_closed: 422,
  registration_not_yet_open: 422,
  team_size_insufficient: 422,
  team_size_exceeded: 422,
  team_member_already_registered: 409,
  team_not_submitted: 409,
  team_state_conflict: 409,
  team_registration_invariant_violation: 422,
  cancellation_reason_required: 422,
  cancellation_reason_too_long: 422,
  cancellation_not_supported_for_paid: 422,
  cancellation_disabled_by_institution: 422,
  cancellation_window_closed: 422,
};

export class TeamError extends Error {
  constructor(
    public readonly code: TeamErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export const toTeamErrorResponse = (error: TeamError): NextResponse => {
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

export type TeamCreateInput = { name: string };
export type TeamUpdateInput = { name: string };
// A username OR an email; classified + resolved in the service.
export type TeamInviteCreateInput = { invitedIdentifier: string };

export const parseTeamCreateInput = (payload: unknown): TeamCreateInput => {
  if (!isRecord(payload)) {
    throw new TeamError("team_invalid_payload", "Request body must be a JSON object");
  }

  const { name } = payload;
  return { name: validateTeamName(name) };
};

export const parseTeamUpdateInput = (payload: unknown): TeamUpdateInput => {
  if (!isRecord(payload)) {
    throw new TeamError("team_invalid_payload", "Request body must be a JSON object");
  }

  const { name } = payload;
  return { name: validateTeamName(name) };
};

export const parseTeamInviteCreateInput = (payload: unknown): TeamInviteCreateInput => {
  if (!isRecord(payload)) {
    throw new TeamError("team_invalid_payload", "Request body must be a JSON object");
  }

  const { invitedIdentifier } = payload;

  // Format classification (email vs username) happens in the service via classifyInviteIdentifier;
  // here we only require a non-empty string.
  if (typeof invitedIdentifier !== "string" || invitedIdentifier.trim().length === 0) {
    throw new TeamError(
      "team_invalid_identifier",
      "invitedIdentifier (a username or email) is required",
    );
  }

  return { invitedIdentifier: invitedIdentifier.trim() };
};

const validateTeamName = (raw: unknown): string => {
  if (typeof raw !== "string") {
    throw new TeamError("team_invalid_name", "name must be a string");
  }

  const trimmed = raw.trim();

  if (trimmed.length < TEAM_NAME_MIN || trimmed.length > TEAM_NAME_MAX) {
    throw new TeamError(
      "team_invalid_name",
      `name must be between ${TEAM_NAME_MIN} and ${TEAM_NAME_MAX} characters`,
    );
  }

  return trimmed;
};

// SHA-256 hashed token pattern (mirrors institution-invitations/invitation-core.ts).
export const generateRawToken = (): string => {
  return randomBytes(32).toString("hex");
};

export const hashToken = (rawToken: string): string => {
  return createHash("sha256").update(rawToken).digest("hex");
};

// First 8 chars only — never log the full raw token.
export const maskToken = (rawToken: string): string => {
  return `${rawToken.slice(0, 8)}…`;
};

export const buildInvitationExpiresAt = (from: Date = new Date()): Date => {
  const expiry = new Date(from);
  expiry.setDate(expiry.getDate() + TEAM_INVITATION_EXPIRY_DAYS);
  return expiry;
};

// Wire-format records returned by service + route layer.
export type TeamRecord = {
  id: string;
  competitionId: string;
  name: string;
  captainId: string;
  status: TeamStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamRosterEntry = {
  membershipId: string;
  userId: string;
  role: TeamMembershipRole;
  status: TeamMembershipStatus;
  joinedAt: Date;
  displayName: string | null;
  email: string;
};

export type TeamInvitationEntry = {
  id: string;
  tokenHash: string;
  invitedEmail: string;
  status: TeamInvitationStatus;
  expiresAt: Date;
  createdAt: Date;
};

export type TeamWithRoster = {
  team: TeamRecord;
  roster: TeamRosterEntry[];
  pendingInvitations: TeamInvitationEntry[];
};

export type TeamInvitationMeta = {
  id: string;
  teamId: string;
  teamName: string;
  competitionId: string;
  competitionTitle: string;
  invitedEmail: string;
  inviterDisplayName: string | null;
  status: TeamInvitationStatus;
  expiresAt: Date;
  createdAt: Date;
};
