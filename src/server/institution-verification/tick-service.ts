import { and, asc, desc, eq, gt, isNull, ne, sql, type SQL } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  hostOrganizationEmails,
  institutionMemberships,
  institutionVerificationAudit,
  institutionVerificationSubmissions,
  institutions,
  users,
  type InstitutionVerificationStatus,
} from "@/server/db/schema";
import {
  holdsOrganizationEmailNotUsedAsSignInEmail,
  trustHostByTickInTransaction,
} from "@/server/host-trust/host-trust-service";
import {
  buildInstitutionWorkspaceAccessDeniedError,
  findInstitutionWorkspaceByOwnerAndSlug,
} from "@/server/institution-workspace/institution-service";
import {
  recordOperatorAuditEntry,
  type ResolvedPlatformOpsActor,
} from "@/server/platform-ops/operator-actor";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { matchedTickDomain, normalizedWebsiteHostOf } from "./tick-domain";
import {
  TICK_REMOVED_NAME_PROOF,
  TICK_REMOVED_RENAME_DURING_PROOF,
  TICK_REMOVED_WEBSITE_DURING_PROOF,
  writeTickTransition,
  type TickPath,
} from "./tick-transition";
import { VerificationError } from "./verification-core";

assertServerOnly("server/institution-verification/tick-service");

type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

const OWNER_ROLE = "institution_owner";
const ACTIVE_MEMBERSHIP = "active";
const PATH_A_AUDIT_REASON = "tick_path_a_domain";
const PATH_A_CLOSED_REQUEST_NOTE = "Ditutup karena centang sudah didapat lewat email organisasi.";

export type TickClosure =
  | { closed: false }
  | {
      closed: true;
      cause: "staff" | "automatic";
      closedInstitutionId: string;
      auditRowId: string;
    };

export type TickByOrganizationDomainResult = {
  id: string;
  verificationStatus: InstitutionVerificationStatus;
  tickPath: TickPath | null;
};

export type ClosedTickRequest = {
  id: string;
  submittedByUserId: string | null;
  requestedPath: TickPath;
};

const AUTOMATIC_CLOSURE_REASONS: readonly string[] = [
  TICK_REMOVED_WEBSITE_DURING_PROOF,
  TICK_REMOVED_RENAME_DURING_PROOF,
];

// A closing row counts only while no newer row reached verified, so a document approval or a staff
// restore opens the workspace again, whichever arm closed it.
const NO_NEWER_ROW_TO_VERIFIED: SQL = sql`NOT EXISTS (
  SELECT 1 FROM institution_verification_audit newer
  WHERE newer.institution_id = ${institutionVerificationAudit.institutionId}
    AND newer.to_status = 'verified'
    AND (newer.created_at, newer.id) >
      (${institutionVerificationAudit.createdAt}, ${institutionVerificationAudit.id})
)`;

// A workspace is closed to Path A and Path B after staff turned it down or took its tick away, or
// after its tick went by itself during a name proof. Only a document approval or a staff restore
// (a newer row to verified) opens it again. Rows are ordered by created_at then id, and the
// comparison runs in SQL because a JavaScript Date drops the microseconds Postgres keeps.
export const readTickClosure = async (
  tx: TransactionClient,
  institutionId: string,
): Promise<TickClosure> => {
  const [staffClosingRow] = await tx
    .select({ id: institutionVerificationAudit.id })
    .from(institutionVerificationAudit)
    .where(
      and(
        eq(institutionVerificationAudit.institutionId, institutionId),
        eq(institutionVerificationAudit.toStatus, "rejected"),
        NO_NEWER_ROW_TO_VERIFIED,
      ),
    )
    .orderBy(desc(institutionVerificationAudit.createdAt), desc(institutionVerificationAudit.id))
    .limit(1);
  if (staffClosingRow) {
    return {
      closed: true,
      cause: "staff",
      closedInstitutionId: institutionId,
      auditRowId: staffClosingRow.id,
    };
  }

  const [newestRemoval] = await tx
    .select({
      id: institutionVerificationAudit.id,
      actorUserId: institutionVerificationAudit.actorUserId,
      reason: institutionVerificationAudit.reason,
    })
    .from(institutionVerificationAudit)
    .where(
      and(
        eq(institutionVerificationAudit.institutionId, institutionId),
        eq(institutionVerificationAudit.fromStatus, "verified"),
        ne(institutionVerificationAudit.toStatus, "verified"),
        NO_NEWER_ROW_TO_VERIFIED,
      ),
    )
    .orderBy(desc(institutionVerificationAudit.createdAt), desc(institutionVerificationAudit.id))
    .limit(1);
  if (!newestRemoval) return { closed: false };

  const isNameProofSweep =
    newestRemoval.actorUserId === null && newestRemoval.reason === TICK_REMOVED_NAME_PROOF;
  const isRemovalDuringProof =
    newestRemoval.reason !== null && AUTOMATIC_CLOSURE_REASONS.includes(newestRemoval.reason);
  if (!isNameProofSweep && !isRemovalDuringProof) return { closed: false };

  return {
    closed: true,
    cause: "automatic",
    closedInstitutionId: institutionId,
    auditRowId: newestRemoval.id,
  };
};

export const hasPublishedPaidCompetition = async (
  tx: TransactionClient,
  institutionId: string,
): Promise<boolean> => {
  const [paidCompetition] = await tx
    .select({ id: competitions.id })
    .from(competitions)
    .where(
      and(
        eq(competitions.institutionId, institutionId),
        eq(competitions.status, "published"),
        isNull(competitions.deletedAt),
        gt(competitions.feeAmount, 0),
      ),
    )
    .limit(1);
  return paidCompetition !== undefined;
};

// Closes the workspace's one pending request, when there is one. Returns the closed row so a
// caller can read who submitted it, and null when nothing was pending.
export const closePendingRequestInTransaction = async (
  tx: TransactionClient,
  input: {
    institutionId: string;
    status: "approved" | "rejected";
    reviewerUserId: string | null;
    reviewerNotes: string;
    onlyRequestedPath?: TickPath;
  },
): Promise<ClosedTickRequest | null> => {
  const [closed] = await tx
    .update(institutionVerificationSubmissions)
    .set({
      status: input.status,
      reviewerUserId: input.reviewerUserId,
      reviewerNotes: input.reviewerNotes,
      reviewedAt: sql`now()`,
    })
    .where(
      and(
        eq(institutionVerificationSubmissions.institutionId, input.institutionId),
        eq(institutionVerificationSubmissions.status, "pending_review"),
        input.onlyRequestedPath
          ? eq(institutionVerificationSubmissions.requestedPath, input.onlyRequestedPath)
          : undefined,
      ),
    )
    .returning({
      id: institutionVerificationSubmissions.id,
      submittedByUserId: institutionVerificationSubmissions.submittedByUserId,
      requestedPath: institutionVerificationSubmissions.requestedPath,
    });
  return closed ?? null;
};

const isActiveOwnerOf = async (
  tx: TransactionClient,
  institutionId: string,
  userId: string,
): Promise<boolean> => {
  const [membership] = await tx
    .select({ id: institutionMemberships.id })
    .from(institutionMemberships)
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.userId, userId),
        eq(institutionMemberships.membershipRole, OWNER_ROLE),
        eq(institutionMemberships.status, ACTIVE_MEMBERSHIP),
      ),
    )
    .limit(1);
  return membership !== undefined;
};

// The submitter of a request that just got the workspace its tick is trusted when it is still an
// active owner of that workspace, and the trust is written to the platform_ops audit log. Nobody
// else is trusted, and a trust that does not apply is not an error.
export const trustTickSubmitterInTransaction = async (
  tx: TransactionClient,
  actor: ResolvedPlatformOpsActor,
  input: {
    institutionId: string;
    submissionId: string;
    submitterUserId: string | null;
    requestedPath: TickPath;
    closedByStaffOverride?: true;
  },
): Promise<boolean> => {
  if (input.submitterUserId === null) return false;

  const stillOwner = await isActiveOwnerOf(tx, input.institutionId, input.submitterUserId);
  if (!stillOwner) return false;

  const raised = await trustHostByTickInTransaction(tx, input.submitterUserId);
  if (!raised) return false;

  await recordOperatorAuditEntry(tx, actor, {
    targetUserId: input.submitterUserId,
    eventType: "host_trust.raised_by_tick",
    metadata: {
      institutionId: input.institutionId,
      submissionId: input.submissionId,
      requestedPath: input.requestedPath,
      ...(input.closedByStaffOverride ? { closedByStaffOverride: true } : {}),
    },
  });
  return true;
};

const buildPathAClosedRefusal = (
  closure: Extract<TickClosure, { closed: true }>,
): VerificationError =>
  new VerificationError(
    "institution_tick_path_a_closed",
    409,
    "This workspace's tick was removed by staff or by a name proof rule, so it can only return through documents or a staff decision",
    { cause: closure.cause, closedInstitutionId: closure.closedInstitutionId },
  );

const assertActorTrustNotRemoved = async (
  tx: TransactionClient,
  actorUserId: string,
): Promise<void> => {
  const [actor] = await tx
    .select({ hostTrustRemovedAt: users.hostTrustRemovedAt })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  if (actor?.hostTrustRemovedAt) {
    throw new VerificationError(
      "institution_tick_owner_trust_removed",
      403,
      "Platform staff removed this account's host trust, so it cannot tick a workspace by organization email",
    );
  }
};

const readOtherWorkspaceClosure = async (
  tx: TransactionClient,
  userId: string,
  institutionId: string,
): Promise<TickClosure> => {
  const otherWorkspaces = await tx
    .select({ institutionId: institutionMemberships.institutionId })
    .from(institutionMemberships)
    .where(
      and(
        eq(institutionMemberships.userId, userId),
        eq(institutionMemberships.membershipRole, OWNER_ROLE),
        eq(institutionMemberships.status, ACTIVE_MEMBERSHIP),
        ne(institutionMemberships.institutionId, institutionId),
      ),
    )
    .orderBy(asc(institutionMemberships.institutionId));

  for (const workspace of otherWorkspaces) {
    const closure = await readTickClosure(tx, workspace.institutionId);
    if (closure.closed) return closure;
  }
  return { closed: false };
};

const assertNoClosureOnOtherWorkspacesOf = async (
  tx: TransactionClient,
  actorUserId: string,
  institutionId: string,
): Promise<void> => {
  const closure = await readOtherWorkspaceClosure(tx, actorUserId, institutionId);
  if (closure.closed) throw buildPathAClosedRefusal(closure);
};

const readUsableOrganizationEmailDomain = async (
  tx: TransactionClient,
  userId: string,
): Promise<string | null> => {
  const [organizationEmail] = await tx
    .select({ domain: hostOrganizationEmails.domain })
    .from(hostOrganizationEmails)
    .where(eq(hostOrganizationEmails.userId, userId))
    .limit(1);
  if (!organizationEmail) return null;
  const holdsItAlone = await holdsOrganizationEmailNotUsedAsSignInEmail(tx, userId);
  return holdsItAlone ? organizationEmail.domain : null;
};

const readOwnOrganizationEmailDomain = async (
  tx: TransactionClient,
  actorUserId: string,
): Promise<string> => {
  const domain = await readUsableOrganizationEmailDomain(tx, actorUserId);
  if (domain === null) {
    throw new VerificationError(
      "institution_tick_no_organization_email",
      422,
      "Confirm an organization email of your own first",
    );
  }
  return domain;
};

// Path A: the owner's confirmed Email organisasi is on the workspace's own website domain, so the
// workspace is ticked at once and no staff look is needed. Every refusal writes nothing.
export const tickByOrganizationDomain = async (
  actorUserId: string,
  institutionSlug: string,
  db: Database = getDb(),
): Promise<TickByOrganizationDomainResult> => {
  const result = await db.transaction(async (tx) => {
    const workspace = await findInstitutionWorkspaceByOwnerAndSlug(
      actorUserId,
      institutionSlug,
      tx,
    );
    if (!workspace) {
      throw await buildInstitutionWorkspaceAccessDeniedError(actorUserId, institutionSlug, tx);
    }
    const institutionId = workspace.institutionId;

    // The row lock makes a website change that is already writing finish first, so the website read
    // here is the committed one.
    const [institution] = await tx
      .select({
        verificationStatus: institutions.verificationStatus,
        websiteUrl: institutions.websiteUrl,
        suspendedAt: institutions.suspendedAt,
      })
      .from(institutions)
      .where(eq(institutions.id, institutionId))
      .for("update")
      .limit(1);
    if (!institution) {
      throw await buildInstitutionWorkspaceAccessDeniedError(actorUserId, institutionSlug, tx);
    }

    await assertActorTrustNotRemoved(tx, actorUserId);

    if (institution.suspendedAt) {
      throw new VerificationError(
        "institution_suspended",
        403,
        "This institution has been suspended by platform ops",
      );
    }

    if (institution.verificationStatus === "verified") {
      throw new VerificationError(
        "institution_already_verified",
        409,
        "This institution is already verified",
      );
    }

    const closure = await readTickClosure(tx, institutionId);
    if (closure.closed) throw buildPathAClosedRefusal(closure);

    await assertNoClosureOnOtherWorkspacesOf(tx, actorUserId, institutionId);

    if (await hasPublishedPaidCompetition(tx, institutionId)) {
      throw new VerificationError(
        "institution_tick_live_paid_competition",
        409,
        "This workspace has a published paid competition, so its tick can only return through documents",
      );
    }

    const emailDomain = await readOwnOrganizationEmailDomain(tx, actorUserId);

    const websiteUrl = institution.websiteUrl;
    if (websiteUrl === null) {
      throw new VerificationError(
        "institution_tick_no_website",
        422,
        "Set the workspace website first",
      );
    }

    const matchedDomain = matchedTickDomain(emailDomain, websiteUrl);
    if (matchedDomain === null) {
      throw new VerificationError(
        "institution_tick_domain_mismatch",
        422,
        "The organization email domain does not match the workspace website domain",
      );
    }

    const { institution: ticked } = await writeTickTransition(tx, {
      institutionId,
      from: institution.verificationStatus,
      to: "verified",
      tickPath: "domain",
      tickDomain: matchedDomain,
      nameState: "cleared",
      actorUserId,
      reason: PATH_A_AUDIT_REASON,
      extraWhere: eq(institutions.websiteUrl, websiteUrl),
    });

    await closePendingRequestInTransaction(tx, {
      institutionId,
      status: "rejected",
      reviewerUserId: null,
      reviewerNotes: PATH_A_CLOSED_REQUEST_NOTE,
    });

    return {
      id: ticked.id,
      verificationStatus: ticked.verificationStatus,
      tickPath: ticked.tickPath,
    };
  });

  logger.info("institution.tick.path_a_granted", {
    institutionId: result.id,
    actorUserId,
  });

  return result;
};

export type TickPageClosureCause = Extract<TickClosure, { closed: true }>["cause"];

export type TickPageState = {
  workspaceClosure: TickPageClosureCause | null;
  otherWorkspaceClosure: TickPageClosureCause | null;
  hasPublishedPaidCompetition: boolean;
  organizationEmailDomain: string | null;
  websiteHost: string | null;
  domainsMatch: boolean;
};

const causeOf = (closure: TickClosure): TickPageClosureCause | null =>
  closure.closed ? closure.cause : null;

export const readTickPageState = async (
  viewerUserId: string,
  institutionId: string,
  db: Database = getDb(),
): Promise<TickPageState> =>
  db.transaction(async (tx) => {
    const [institution] = await tx
      .select({ websiteUrl: institutions.websiteUrl })
      .from(institutions)
      .where(eq(institutions.id, institutionId))
      .limit(1);
    const websiteUrl = institution?.websiteUrl ?? null;
    const organizationEmailDomain = await readUsableOrganizationEmailDomain(tx, viewerUserId);
    const workspaceClosure = await readTickClosure(tx, institutionId);
    const otherWorkspaceClosure = await readOtherWorkspaceClosure(tx, viewerUserId, institutionId);
    const domainsMatch =
      organizationEmailDomain !== null &&
      websiteUrl !== null &&
      matchedTickDomain(organizationEmailDomain, websiteUrl) !== null;

    return {
      workspaceClosure: causeOf(workspaceClosure),
      otherWorkspaceClosure: causeOf(otherWorkspaceClosure),
      hasPublishedPaidCompetition: await hasPublishedPaidCompetition(tx, institutionId),
      organizationEmailDomain,
      websiteHost: websiteUrl === null ? null : normalizedWebsiteHostOf(websiteUrl),
      domainsMatch,
    };
  });
