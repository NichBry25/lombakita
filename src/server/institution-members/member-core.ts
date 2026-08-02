import { NextResponse } from "next/server";
import type { InstitutionMembershipRole } from "@/server/db/schema";

export type MemberRecord = {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  role: InstitutionMembershipRole;
  joinedAt: Date;
};

type MemberErrorCode =
  | "member_not_found"
  | "member_self_action"
  | "member_last_admin"
  | "member_invalid_role"
  | "member_invalid_payload"
  | "role_escalation_forbidden"
  | "last_owner_demotion_forbidden";

export class MemberError extends Error {
  constructor(
    public readonly code: MemberErrorCode,
    public readonly httpStatus: 400 | 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

export const toMemberErrorResponse = (error: MemberError): NextResponse => {
  return NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.httpStatus },
  );
};

// All three membership roles are valid assignment targets.
// Promotion to institution_owner or institution_staff requires recruiter verification
// on the target account — enforced in the service layer, not here.
// institution_member is a valid demotion target for any account type.
const ALLOWED_ROLES: readonly InstitutionMembershipRole[] = [
  "institution_owner",
  "institution_staff",
  "institution_member",
];

export const parseRoleChangeBody = (payload: unknown): { role: InstitutionMembershipRole } => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new MemberError("member_invalid_payload", 400, "Request body must be a JSON object");
  }

  const { role } = payload as Record<string, unknown>;

  if (typeof role !== "string" || !ALLOWED_ROLES.includes(role as InstitutionMembershipRole)) {
    throw new MemberError(
      "member_invalid_role",
      400,
      `role must be one of: ${ALLOWED_ROLES.join(", ")}`,
    );
  }

  return { role: role as InstitutionMembershipRole };
};

// Pure function: returns true if the target membership is the sole remaining institution_owner.
// Used for last-owner guard logic independently of any DB call.
export const isLastAdmin = (
  activeMemberships: { membershipId: string; role: InstitutionMembershipRole }[],
  targetMembershipId: string,
): boolean => {
  const admins = activeMemberships.filter((m) => m.role === "institution_owner");
  if (admins.length !== 1) return false;
  return admins[0]!.membershipId === targetMembershipId;
};
