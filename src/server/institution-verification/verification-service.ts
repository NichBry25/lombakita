import { and, asc, desc, eq, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionMemberships,
  institutionVerificationAudit,
  institutions,
  users,
  type InstitutionVerificationStatus,
} from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  assertValidTransition,
  isVerificationStatus,
  VerificationError,
} from "@/server/institution-verification/verification-core";
import {
  sendInstitutionRejectedEmail,
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

  const rows = await db
    .select({
      id: institutions.id,
      displayName: institutions.displayName,
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
    .where(statusWhere)
    .orderBy(desc(institutions.createdAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  // Count total for pagination (separate query to keep main query simple)
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(institutions)
    .where(statusWhere);

  return {
    institutions: rows,
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

  // TODO(step-2.5): race condition — this SELECT is outside the transaction. Two concurrent
  // PATCH requests can both read the same verificationStatus, pass assertValidTransition,
  // and both commit, producing duplicate audit entries. Fix: add
  // AND verification_status = <expected_from> to the UPDATE WHERE clause and treat
  // zero rows updated as 409. Required before Phase 6 when multiple ops staff use this tool.
  const [current] = await db
    .select({
      id: institutions.id,
      displayName: institutions.displayName,
      verificationStatus: institutions.verificationStatus,
    })
    .from(institutions)
    .where(eq(institutions.id, options.institutionId))
    .limit(1);

  if (!current) {
    throw new VerificationError("verification_not_found", 404, "Institution not found");
  }

  assertValidTransition(current.verificationStatus, options.targetStatus);

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

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(institutions)
      .set(statusUpdates)
      .where(eq(institutions.id, options.institutionId))
      .returning({
        id: institutions.id,
        verificationStatus: institutions.verificationStatus,
        verifiedAt: institutions.verifiedAt,
        rejectedAt: institutions.rejectedAt,
        rejectionReason: institutions.rejectionReason,
      });

    if (!updated) {
      throw new VerificationError("verification_not_found", 404, "Institution not found");
    }

    institutionSnapshot = updated;

    const [auditRow] = await tx
      .insert(institutionVerificationAudit)
      .values({
        institutionId: options.institutionId,
        actorUserId: options.actorUserId,
        fromStatus: current.verificationStatus,
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
    from: current.verificationStatus,
    to: options.targetStatus,
    reason: options.reason,
  });

  // Post-commit email dispatch — non-blocking and non-fatal.
  // adminRow lookup runs after the committed transaction; wrap in try/catch so a DB error
  // here does not produce a 500 response that makes the caller think the transition failed.
  if (options.targetStatus === "verified" || options.targetStatus === "rejected") {
    try {
      const [adminRow] = await db
        .select({ email: users.email })
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
        const emailTask =
          options.targetStatus === "verified"
            ? sendInstitutionVerifiedEmail({
                toEmail: adminRow.email,
                institutionDisplayName: current.displayName,
              })
            : sendInstitutionRejectedEmail({
                toEmail: adminRow.email,
                institutionDisplayName: current.displayName,
                rejectionReason: options.reason!,
              });

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
