import { AccessError } from "@/server/auth/access-core";
import type { InstitutionMembershipRecord } from "@/server/user-domain/context";

export const pickInstitutionMembership = (
  memberships: InstitutionMembershipRecord[],
  institutionId: string,
): InstitutionMembershipRecord | null => {
  return memberships.find((membership) => membership.institutionId === institutionId) ?? null;
};

export const assertInstitutionMembership = (
  membership: InstitutionMembershipRecord | null,
): InstitutionMembershipRecord => {
  if (!membership || membership.membershipStatus !== "active") {
    throw new AccessError("forbidden", 403, "Institution membership required");
  }

  return membership;
};

export const assertInstitutionRole = (
  membership: InstitutionMembershipRecord,
  allowedRoles: readonly InstitutionMembershipRecord["membershipRole"][],
): InstitutionMembershipRecord => {
  if (!allowedRoles.includes(membership.membershipRole)) {
    throw new AccessError("forbidden", 403, "Insufficient institution role");
  }

  return membership;
};
