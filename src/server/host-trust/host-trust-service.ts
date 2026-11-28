import { and, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { SELF_SERVICE_ROLES } from "@/lib/access/roles";
import { normalizeEmail } from "@/server/auth/credentials-auth";
import type { Database } from "@/server/db/client";
import { hostOrganizationEmails, users } from "@/server/db/schema";
import {
  extractEmailDomain,
  holdsOnlyPrintableAscii,
  isNeverOrganizationEmailDomain,
} from "@/server/host-trust/email-domain";
import { findRemovedHostMatch } from "@/server/host-trust/removed-host-identity";
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

export const holdsOrganizationEmailNotUsedAsSignInEmail = async (
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
  if (domain === null || isNeverOrganizationEmailDomain(domain)) return false;

  // Recording the address needs this account's own row free and the address held by no one, so a
  // row of either kind means trustHostInTransaction could not record it.
  const [blockingOrganizationEmail] = await tx
    .select({ userId: hostOrganizationEmails.userId })
    .from(hostOrganizationEmails)
    .where(
      or(eq(hostOrganizationEmails.userId, userId), eq(hostOrganizationEmails.email, signInEmail)),
    )
    .limit(1);
  return blockingOrganizationEmail === undefined;
};

export const resolveAutomaticTrustSource = async (
  tx: Database,
  userId: string,
): Promise<AutomaticTrustSource | null> => {
  if (await holdsOrganizationEmailNotUsedAsSignInEmail(tx, userId)) return "organization_email";
  if (await holdsConfirmedSignInEmailOnOrganizationDomain(tx, userId)) return "sign_in_email";
  return null;
};

type AutomaticTrustCandidate = { email: string; source: AutomaticTrustSource };

// The account and the source trustHostInTransaction would trust, read without writing. Null when
// the account is not eligible, no source holds, or it shares a proven email or a given phone with
// another account whose trust staff removed in the last 2 years. The host step, the Email organisasi
// confirm, the publish press and readiness all read this one answer.
const readAutomaticTrustCandidate = async (
  tx: Database,
  userId: string,
): Promise<AutomaticTrustCandidate | null> => {
  const [eligibleAccount] = await tx
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), automaticTrustEligibility))
    .limit(1);
  if (!eligibleAccount) return null;

  const source = await resolveAutomaticTrustSource(tx, userId);
  if (source === null) return null;

  // Read after the source, so an account no source would trust never needs the hash key.
  const removedHostMatch = await findRemovedHostMatch(tx, userId);
  if (removedHostMatch !== null) return null;
  return { email: eligibleAccount.email, source };
};

// Whether the press's own trust step would trust this account now. It reads what
// trustHostInTransaction reads before it writes, so readiness and the press give one answer.
export const wouldTrustHostAutomatically = async (
  db: Database,
  userId: string,
): Promise<boolean> => {
  const candidate = await readAutomaticTrustCandidate(db, userId);
  return candidate !== null;
};

// Writes the trust and, for the sign-in email source, the Email organisasi row. Returns the source
// that trusted the account, or null when nothing was written. Writes no audit row and sends no
// notice. A conflicting row ends in null and never a unique violation, which would abort the
// caller's transaction.
export const trustHostInTransaction = async (
  tx: Database,
  userId: string,
): Promise<AutomaticTrustSource | null> => {
  const candidate = await readAutomaticTrustCandidate(tx, userId);
  if (candidate === null) return null;

  if (candidate.source === "sign_in_email") {
    const email = normalizeEmail(candidate.email);
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

  const raised = await raiseEligibleHostInTransaction(tx, userId);
  if (!raised) return null;

  return candidate.source;
};

// Raises the account to the elevated tier when automaticTrustEligibility holds. Reads no trust
// source, so it is the one statement that every automatic trust path shares.
export const raiseEligibleHostInTransaction = async (
  tx: Database,
  userId: string,
): Promise<boolean> => {
  const trustedRows = await tx
    .update(users)
    .set({ recruiterVerificationTier: "elevated", updatedAt: sql`now()` })
    .where(and(eq(users.id, userId), automaticTrustEligibility))
    .returning({ id: users.id });
  return trustedRows.length > 0;
};

// The trust a tick gives its submitter. The tick itself is the evidence, so no organization email
// is read or recorded. An account that shares a proven email or a given phone with another account
// whose trust staff removed in the last 2 years is not trusted. Writes no audit row and sends no
// notice.
export const trustHostByTickInTransaction = async (
  tx: Database,
  userId: string,
): Promise<boolean> => {
  const [eligibleAccount] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), automaticTrustEligibility))
    .limit(1);
  if (!eligibleAccount) return false;

  // Read after eligibility, so an account the raise would refuse never needs the hash key.
  const removedHostMatch = await findRemovedHostMatch(tx, userId);
  if (removedHostMatch !== null) return false;

  return raiseEligibleHostInTransaction(tx, userId);
};
