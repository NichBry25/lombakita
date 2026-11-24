import { and, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { SELF_SERVICE_ROLES } from "@/lib/access/roles";
import { normalizeEmail } from "@/server/auth/credentials-auth";
import { getDb, type Database } from "@/server/db/client";
import { hostOrganizationEmails, institutionMemberships, users } from "@/server/db/schema";
import {
  extractEmailDomain,
  holdsOnlyPrintableAscii,
  isFreeOrThrowawayEmailDomain,
} from "@/server/host-trust/email-domain";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/host-trust-service");

export type AutomaticTrustSource = "organization_email" | "sign_in_email";

// One predicate for every statement that decides whether an account may be trusted automatically.
export const automaticTrustEligibility: SQL = and(
  eq(users.recruiterVerificationTier, "minimal"),
  isNotNull(users.recruiterVerifiedAt),
  isNull(users.hostTrustRemovedAt),
  isNotNull(users.emailVerified),
  inArray(users.role, [...SELF_SERVICE_ROLES]),
)!;

const holdsOrganizationEmailNotUsedAsSignInEmail = async (
  tx: Database,
  userId: string,
): Promise<boolean> => {
  const [organizationEmail] = await tx
    .select({ email: hostOrganizationEmails.email })
    .from(hostOrganizationEmails)
    .where(eq(hostOrganizationEmails.userId, userId))
    .limit(1);
  if (!organizationEmail) return false;

  const [otherAccountSigningInWithIt] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(ne(users.id, userId), sql`lower(${users.email}) = ${organizationEmail.email}`))
    .limit(1);
  return otherAccountSigningInWithIt === undefined;
};

const holdsConfirmedSignInEmailOnOrganizationDomain = async (
  tx: Database,
  userId: string,
): Promise<boolean> => {
  const [account] = await tx
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account || account.emailVerified === null) return false;

  const signInEmail = normalizeEmail(account.email);
  if (!holdsOnlyPrintableAscii(signInEmail)) return false;

  const domain = extractEmailDomain(signInEmail);
  if (domain === null || isFreeOrThrowawayEmailDomain(domain)) return false;

  const [otherAccountHoldingItAsOrganizationEmail] = await tx
    .select({ userId: hostOrganizationEmails.userId })
    .from(hostOrganizationEmails)
    .where(
      and(ne(hostOrganizationEmails.userId, userId), eq(hostOrganizationEmails.email, signInEmail)),
    )
    .limit(1);
  return otherAccountHoldingItAsOrganizationEmail === undefined;
};

export const resolveAutomaticTrustSource = async (
  tx: Database,
  userId: string,
): Promise<AutomaticTrustSource | null> => {
  if (await holdsOrganizationEmailNotUsedAsSignInEmail(tx, userId)) return "organization_email";
  if (await holdsConfirmedSignInEmailOnOrganizationDomain(tx, userId)) return "sign_in_email";
  return null;
};

// Writes the trust and, for the sign-in email source, the Email organisasi row. Returns the source
// that trusted the account, or null when nothing was written. Writes no audit row and sends no
// notice. A conflicting row ends in null and never a unique violation, which would abort the
// caller's transaction.
export const trustHostInTransaction = async (
  tx: Database,
  userId: string,
): Promise<AutomaticTrustSource | null> => {
  const [eligibleAccount] = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), automaticTrustEligibility))
    .limit(1);
  if (!eligibleAccount) return null;

  const source = await resolveAutomaticTrustSource(tx, userId);
  if (source === null) return null;

  if (source === "sign_in_email") {
    const email = normalizeEmail(eligibleAccount.email);
    const recordedRows = await tx
      .insert(hostOrganizationEmails)
      .values({
        userId,
        email,
        domain: extractEmailDomain(email)!,
        confirmedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning({ userId: hostOrganizationEmails.userId });
    if (recordedRows.length === 0) return null;
  }

  const trustedRows = await tx
    .update(users)
    .set({ recruiterVerificationTier: "elevated", updatedAt: sql`now()` })
    .where(and(eq(users.id, userId), automaticTrustEligibility))
    .returning({ id: users.id });
  if (trustedRows.length === 0) return null;

  return source;
};

// True when an active institution_owner of the institution is a trusted host whose account is active and not suspended.
const institutionHasTrustedOwner = async (
  institutionId: string,
  db: Database,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: institutionMemberships.id })
    .from(institutionMemberships)
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.membershipRole, "institution_owner"),
        eq(institutionMemberships.status, "active"),
        eq(users.recruiterVerificationTier, "elevated"),
        eq(users.status, "active"),
        isNull(users.suspendedAt),
      ),
    )
    .limit(1);

  return row !== undefined;
};

// Does not check that the actor belongs to the institution. Callers run assertCompetitionAccess
// first and pass the institution id of the competition row it loaded.
export const isPublishTrustSatisfied = async (
  actorUserId: string,
  institutionId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [actor] = await db
    .select({
      tier: users.recruiterVerificationTier,
      hostTrustRemovedAt: users.hostTrustRemovedAt,
    })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  if (!actor) return false;

  if (actor.tier === "elevated") return true;
  if (actor.hostTrustRemovedAt !== null) return false;
  return institutionHasTrustedOwner(institutionId, db);
};
