import { and, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { SELF_SERVICE_ROLES } from "@/lib/access/roles";
import { logger } from "@/lib/logger";
import { assertAccountNotDeactivated } from "@/server/accounts/deactivated-account";
import { enqueueHostTrustRemoved } from "@/server/async/enqueue";
import { normalizeEmail } from "@/server/auth/credentials-auth";
import { getDb, type Database } from "@/server/db/client";
import { hostOrganizationEmails, users } from "@/server/db/schema";
import {
  extractEmailDomain,
  holdsOnlyPrintableAscii,
  isFreeOrThrowawayEmailDomain,
} from "@/server/host-trust/email-domain";
import {
  OperatorActorError,
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
  type OperatorActorTransaction,
} from "@/server/platform-ops/operator-actor";
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
// the account is not eligible or no source holds.
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

  const trustedRows = await tx
    .update(users)
    .set({ recruiterVerificationTier: "elevated", updatedAt: sql`now()` })
    .where(and(eq(users.id, userId), automaticTrustEligibility))
    .returning({ id: users.id });
  if (trustedRows.length === 0) return null;

  return candidate.source;
};

export type HostTrustRemovalErrorCode =
  | "host_trust_reason_required"
  | "host_trust_account_not_found"
  | "host_trust_not_trusted"
  | "account_deactivated";

export class HostTrustRemovalError extends Error {
  constructor(
    public readonly code: HostTrustRemovalErrorCode,
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type HostTrustRemovalResult = { accountId: string; tier: "minimal" };

const HOST_TRUST_REASON_MAX_LENGTH = 1000;
const HOST_TRUST_REMOVED_EVENT = "host_trust.removed";

const trimmedRemovalReasonOrRefuse = (reason: string): string => {
  const trimmedReason = reason.trim();
  if (trimmedReason.length === 0 || trimmedReason.length > HOST_TRUST_REASON_MAX_LENGTH) {
    throw new HostTrustRemovalError(
      "host_trust_reason_required",
      400,
      "A trust removal carries a reason of 1 to 1000 characters",
    );
  }
  return trimmedReason;
};

// The opt-in holds this transaction's id and lasts for this transaction only, so the tier trigger
// lets exactly this transaction move a tier from elevated to minimal, and no later one.
const optIntoTrustRemoval = async (tx: OperatorActorTransaction): Promise<void> => {
  await tx.execute(sql`select set_config('lombakita.trust_removal', txid_current()::text, true)`);
};

// The one UPDATE of a removal: this account only, and only while it is trusted.
const lowerTrustedHostToMinimal = (tx: OperatorActorTransaction, accountId: string) =>
  tx
    .update(users)
    .set({
      recruiterVerificationTier: "minimal",
      hostTrustRemovedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(users.id, accountId), eq(users.recruiterVerificationTier, "elevated")))
    .returning({ id: users.id });

// No row moved: the account does not exist, or it is not trusted.
const refuseUntrustedAccount = async (
  tx: OperatorActorTransaction,
  accountId: string,
): Promise<never> => {
  const [account] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  if (!account) {
    throw new HostTrustRemovalError("host_trust_account_not_found", 404, "Account not found");
  }
  throw new HostTrustRemovalError(
    "host_trust_not_trusted",
    409,
    "The account is not a trusted host",
  );
};

// Sent after the commit and never awaited into a failure: a failed enqueue never undoes a removal.
const enqueueTrustRemovedNotice = async (userId: string, reason: string): Promise<void> => {
  try {
    await enqueueHostTrustRemoved({ userId, reason, epoch: Date.now() });
  } catch (error) {
    logger.warn("host_trust.removed_notice_enqueue_failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Staff remove a host's trust with a reason. One transaction: the platform_ops actor is read first,
// the actor may not name its own account, a de-identified account is refused, the reason is checked,
// then the opt-in and the one UPDATE of this account, and the audit row lands with it. The host's
// published competitions stay published. After the commit the notice goes through the two-channel
// job.
export const removeHostTrust = async (
  staffUserId: string,
  accountId: string,
  reason: string,
  db: Database = getDb(),
): Promise<HostTrustRemovalResult> => {
  const recordedReason = await db.transaction(async (tx) => {
    const actor = await resolvePlatformOpsActor(tx, staffUserId);
    if (actor.userId === accountId) {
      throw new OperatorActorError(
        "operator_actor_is_target",
        403,
        "A platform-ops account cannot remove its own host trust",
      );
    }
    await assertAccountNotDeactivated(tx, accountId, HostTrustRemovalError);
    const checkedReason = trimmedRemovalReasonOrRefuse(reason);

    await optIntoTrustRemoval(tx);
    const lowered = await lowerTrustedHostToMinimal(tx, accountId);
    if (lowered.length === 0) await refuseUntrustedAccount(tx, accountId);

    await recordOperatorAuditEntry(tx, actor, {
      targetUserId: accountId,
      eventType: HOST_TRUST_REMOVED_EVENT,
      reason: checkedReason,
      metadata: { from: "elevated", to: "minimal" },
    });
    return checkedReason;
  });

  await enqueueTrustRemovedNotice(accountId, recordedReason);
  return { accountId, tier: "minimal" };
};
