import { isSelfServiceRole, sessionHasRole } from "@/lib/access/roles";

// The role page link a competition page offers a signed-in self-service account without the
// candidate role. Operational accounts are never offered it; the role page and its API refuse them.
export const candidateRoleOfferPath = (
  activeRole: string | null | undefined,
  verifiedRoles: readonly string[] | null | undefined,
  returnPath: string,
): string | null => {
  if (!isSelfServiceRole(activeRole)) return null;
  if (sessionHasRole(activeRole, verifiedRoles, "candidate")) return null;
  return `/auth/verify-role?as=candidate&callbackUrl=${encodeURIComponent(returnPath)}`;
};
