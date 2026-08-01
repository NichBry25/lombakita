import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionMemberships,
  institutionVerificationAudit,
  institutions,
  users,
  type InstitutionType,
  type InstitutionVerificationStatus,
} from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  getInstitutionDisplayName,
  institutionOwnerUsernameSql,
} from "@/server/institution-workspace/institution-display-name";
import {
  isPersonalInstitutionType,
  PERSONAL_INSTITUTION_TYPE,
} from "@/server/institution-workspace/institution-type";
import {
  assertValidTransition,
  isVerificationStatus,
  VerificationError,
} from "@/server/institution-verification/verification-core";
import {
  sendInstitutionRejectedEmail,
  sendInstitutionVerificationRevokedEmail,
  sendInstitutionVerifiedEmail,
} from "@/server/institution-verification/verification-email";

assertServerOnly("server/institution-verification/verification-service");

export type InstitutionListItem = {
  id: string;
  displayName: string;
  slug: string;
  verificationStatus: InstitutionVerificationStatus;
  verifiedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  adminEmail: string | null;
};

export type VerificationAuditEntry = {
  id: string;
  actorUserId: string | null;
  fromStatus: InstitutionVerificationStatus;
  toStatus: InstitutionVerificationStatus;
  reason: string | null;
  createdAt: Date;
};

export type VerifyResult = {
  institution: {
    id: string;
    verificationStatus: InstitutionVerificationStatus;
    verifiedAt: Date | null;
    rejectedAt: Date | null;
    rejectionReason: string | null;
  };
  auditEntry: VerificationAuditEntry;
};

const PAGE_SIZE = 20;

// A personal institution has no document verification: it IS its owner, and that owner is vetted
// by the account-level Trusted Recruiter review. `createVerificationSubmission` refuses one
// outright, so a personal row could only ever sit in this queue as a permanently inert entry an
// operator has no evidence to act on. Excluded from both the page query and the count so
// pagination and the total agree. A personal→full upgrade resets verification_status, so an
// upgraded institution enters this queue on its own merits.
const NON_PERSONAL_INSTITUTION = ne(institutions.institutionType, PERSONAL_INSTITUTION_TYPE);

const requirePlatformOps = (actorRole: string): void => {
  if (actorRole !== "platform_ops") {
    throw new AccessError("forbidden", 403, "platform_ops access required");
  }
};

export const listInstitutionsForPlatformOps = async (options: {
  actorRole: string;
  statusFilter?: string;
  page?: number;
  db?: Database;
}): Promise<{ institutions: InstitutionListItem[]; total: number; page: number }> => {
  requirePlatformOps(options.actorRole);

  const db = options.db ?? getDb();
  const page = Math.max(1, options.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const statusWhere =
    typeof options.statusFilter === "string" && isVerificationStatus(options.statusFilter)
      ? eq(institutions.verificationStatus, options.statusFilter)
      : undefined;

  const listWhere = statusWhere
    ? and(NON_PERSONAL_INSTITUTION, statusWhere)
    : NON_PERSONAL_INSTITUTION;

  const rows = await db
    .select({
      id: institutions.id,
      displayName: institutions.displayName,
      institutionType: institutions.institutionType,
      ownerUsername: institutionOwnerUsernameSql,
      slug: institutions.slug,
      verificationStatus: institutions.verificationStatus,
      verifiedAt: institutions.verifiedAt,
      rejectedAt: institutions.rejectedAt,
      rejectionReason: institutions.rejectionReason,
      createdAt: institutions.createdAt,
      // Correlated subquery guarantees exactly one email per institution row.
      // Deterministic selection: earliest active institution_owner by membership created_at.
      adminEmail: sql<string | null>`(
        SELECT u.email
        FROM institution_memberships im
        INNER JOIN users u ON u.id = im.user_id
        WHERE im.institution_id = institutions.id
          AND im.membership_role = 'institution_owner'
          AND im.status = 'active'
        ORDER BY im.created_at ASC
        LIMIT 1
      )`,
    })
    .from(institutions)
    .where(listWhere)
    .orderBy(desc(institutions.createdAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  // Count total for pagination (separate query to keep main query simple)
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(institutions)
    .where(listWhere);

  // Resolve the display name through the helper: a personal institution stores NULL and derives its
  // name from the owner username; full/legacy institutions use the stored value.
  const institutionItems: InstitutionListItem[] = rows.map(
    ({ institutionType, ownerUsername, ...rest }) => ({
      ...rest,
      displayName: getInstitutionDisplayName(
        { displayName: rest.displayName, institutionType },
        { username: ownerUsername },
      ),
    }),
  );

  return {
    institutions: institutionItems,
    total: countRow?.count ?? 0,
    page,
  };
};

export const getInstitutionVerificationAudit = async (
  institutionId: string,
  actorRole: string,
  db: Database = getDb(),
): Promise<VerificationAuditEntry[]> => {
  requirePlatformOps(actorRole);

  return db
    .select({
      id: institutionVerificationAudit.id,
      actorUserId: institutionVerificationAudit.actorUserId,
      fromStatus: institutionVerificationAudit.fromStatus,
      toStatus: institutionVerificationAudit.toStatus,
      reason: institutionVerificationAudit.reason,
      createdAt: institutionVerificationAudit.createdAt,
    })
    .from(institutionVerificationAudit)
    .where(eq(institutionVerificationAudit.institutionId, institutionId))
    .orderBy(asc(institutionVerificationAudit.createdAt));
};

export const verifyInstitution = async (options: {
  institutionId: string;
  targetStatus: InstitutionVerificationStatus;
  reason?: string;
  actorUserId: string;
  actorRole: string;
  db?: Database;
}): Promise<VerifyResult> => {
  requirePlatformOps(options.actorRole);

  const db = options.db ?? getDb();

  const now = new Date();
  const statusUpdates: {
    verificationStatus: InstitutionVerificationStatus;
    updatedAt: ReturnType<typeof sql>;
    verifiedAt?: Date;
    rejectedAt?: Date;
    rejectionReason?: string;
  } = {
    verificationStatus: options.targetStatus,
    updatedAt: sql`now()`,
  };

  if (options.targetStatus === "verified") {
    statusUpdates.verifiedAt = now;
  } else if (options.targetStatus === "rejected") {
    statusUpdates.rejectedAt = now;
    statusUpdates.rejectionReason = options.reason;
  }

  let auditEntry: VerificationAuditEntry;
  let institutionSnapshot: {
    id: string;
    verificationStatus: InstitutionVerificationStatus;
    verifiedAt: Date | null;
    rejectedAt: Date | null;
    rejectionReason: string | null;
  };
  let current: {
    displayName: string | null;
    institutionType: InstitutionType;
    verificationStatus: InstitutionVerificationStatus;
  };

  await db.transaction(async (tx) => {
    // Read and write in one transaction, and pin the UPDATE to the status this decision was made
    // against. Two concurrent PATCHes previously both passed assertValidTransition and both
    // committed, leaving the loser's audit row describing a transition that never happened — which
    // matters now that a revocation can race an approval in either direction.
    const [row] = await tx
      .select({
        displayName: institutions.displayName,
        institutionType: institutions.institutionType,
        verificationStatus: institutions.verificationStatus,
      })
      .from(institutions)
      .where(eq(institutions.id, options.institutionId))
      .limit(1);

    if (!row) {
      throw new VerificationError("verification_not_found", 404, "Institution not found");
    }

    current = row;

    // Personal institutions are filtered out of the platform-ops queue, so this only fires for a
    // request made directly against the endpoint by id. It is the actual guard, not a courtesy:
    // without it the hidden row would still accept a transition and write a meaningless audit entry.
    if (isPersonalInstitutionType(row.institutionType)) {
      throw new VerificationError(
        "institution_verification_not_applicable",
        409,
        "A personal institution has no document verification to review",
      );
    }

    assertValidTransition(row.verificationStatus, options.targetStatus);

    const [updated] = await tx
      .update(institutions)
      .set(statusUpdates)
      .where(
        and(
          eq(institutions.id, options.institutionId),
          eq(institutions.verificationStatus, row.verificationStatus),
        ),
      )
      .returning({
        id: institutions.id,
        verificationStatus: institutions.verificationStatus,
        verifiedAt: institutions.verifiedAt,
        rejectedAt: institutions.rejectedAt,
        rejectionReason: institutions.rejectionReason,
      });

    if (!updated) {
      throw new VerificationError(
        "verification_transition_conflict",
        409,
        "This institution's verification status changed while you were deciding. Reload and try again",
      );
    }

    institutionSnapshot = updated;

    const [auditRow] = await tx
      .insert(institutionVerificationAudit)
      .values({
        institutionId: options.institutionId,
        actorUserId: options.actorUserId,
        fromStatus: row.verificationStatus,
        toStatus: options.targetStatus,
        reason: options.reason ?? null,
      })
      .returning();

    if (!auditRow) {
      throw new Error("Failed to insert verification audit entry");
    }

    auditEntry = {
      id: auditRow.id,
      actorUserId: auditRow.actorUserId,
      fromStatus: auditRow.fromStatus,
      toStatus: auditRow.toStatus,
      reason: auditRow.reason,
      createdAt: auditRow.createdAt,
    };
  });

  logger.info("institution.verification.transitioned", {
    institutionId: options.institutionId,
    actorUserId: options.actorUserId,
    from: current!.verificationStatus,
    to: options.targetStatus,
    reason: options.reason,
  });

  // Post-commit email dispatch — non-blocking and non-fatal.
  // adminRow lookup runs after the committed transaction; wrap in try/catch so a DB error
  // here does not produce a 500 response that makes the caller think the transition failed.
  if (options.targetStatus === "verified" || options.targetStatus === "rejected") {
    try {
      const [adminRow] = await db
        .select({ email: users.email, username: users.username })
        .from(institutionMemberships)
        .innerJoin(users, eq(users.id, institutionMemberships.userId))
        .where(
          and(
            eq(institutionMemberships.institutionId, options.institutionId),
            eq(institutionMemberships.membershipRole, "institution_owner"),
            eq(institutionMemberships.status, "active"),
          ),
        )
        .orderBy(asc(institutionMemberships.createdAt))
        .limit(1);

      if (adminRow) {
        // Resolve the name through the helper: a personal institution derives it from the owner
        // username (the same owner whose email we just loaded).
        const resolvedDisplayName = getInstitutionDisplayName(
          { displayName: current!.displayName, institutionType: current!.institutionType },
          { username: adminRow.username },
        );
        // A 'rejected' target means two different things to the owner depending on where the
        // institution came from: a denied application (from pending/under review) or a verification
        // withdrawn after it had been granted. They get different notices.
        const isRevocation =
          options.targetStatus === "rejected" && current!.verificationStatus === "verified";

        let emailTask: Promise<void>;
        if (options.targetStatus === "verified") {
          emailTask = sendInstitutionVerifiedEmail({
            toEmail: adminRow.email,
            institutionDisplayName: resolvedDisplayName,
          });
        } else if (isRevocation) {
          emailTask = sendInstitutionVerificationRevokedEmail({
            toEmail: adminRow.email,
            institutionDisplayName: resolvedDisplayName,
            revocationReason: options.reason!,
          });
        } else {
          emailTask = sendInstitutionRejectedEmail({
            toEmail: adminRow.email,
            institutionDisplayName: resolvedDisplayName,
            rejectionReason: options.reason!,
          });
        }

        emailTask.catch((err: unknown) => {
          logger.error("institution.verification.email_failed", {
            institutionId: options.institutionId,
            targetStatus: options.targetStatus,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err: unknown) {
      logger.error("institution.verification.post_commit_lookup_failed", {
        institutionId: options.institutionId,
        targetStatus: options.targetStatus,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    institution: institutionSnapshot!,
    auditEntry: auditEntry!,
  };
};
