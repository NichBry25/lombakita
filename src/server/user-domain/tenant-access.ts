import { AccessError } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import type { InstitutionMembershipRole } from "@/server/db/schema";
import {
  getInstitutionMembershipForUser,
  getUserDomainContext,
  type InstitutionMembershipRecord,
  type UserDomainContext,
} from "@/server/user-domain/context";
import {
  assertInstitutionMembership,
  assertInstitutionRole,
} from "@/server/user-domain/tenant-access-core";

export const requireCurrentUserDomainContext = async (): Promise<UserDomainContext> => {
  const session = await requireAuthenticatedSession();
  const context = await getUserDomainContext(session.user.id);

  if (!context) {
    throw new AccessError("forbidden", 403, "User-domain record not found");
  }

  return context;
};

export const requireCurrentUserInstitutionAccess = async (options: {
  institutionId: string;
  allowedRoles?: readonly InstitutionMembershipRole[];
}): Promise<{ membership: InstitutionMembershipRecord; userId: string }> => {
  const session = await requireAuthenticatedSession();

  const membership = await getInstitutionMembershipForUser(session.user.id, options.institutionId, {
    activeOnly: true,
  });

  const activeMembership = assertInstitutionMembership(membership);

  if (options.allowedRoles && options.allowedRoles.length > 0) {
    assertInstitutionRole(activeMembership, options.allowedRoles);
  }

  return {
    membership: activeMembership,
    userId: session.user.id,
  };
};
