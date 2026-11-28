import { and, asc, desc, eq, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionVerificationAudit,
  institutions,
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
  closePendingRequestInTransaction,
  trustTickSubmitterInTransaction,
} from "@/server/institution-verification/tick-service";
import {
  writeTickTransition,
  type TickPath,
  type TickTransitionResult,
} from "@/server/institution-verification/tick-transition";
import {
  resolvePlatformOpsActor,
  type ResolvedPlatformOpsActor,
} from "@/server/platform-ops/operator-actor";
import { assertOperatorHasNoInstitutionRelationship } from "@/server/institution-verification/operator-institution-conflict";
import { enqueueTickNoticeAfterCommit } from "@/server/institution-verification/name-check-service";
import type { InstitutionTickNoticeKind } from "@/server/async/contracts";

assertServerOnly("server/institution-verification/verification-service");

export type InstitutionListItem = {
  id: string;
  displayName: string;
  slug: string;
  verificationStatus: InstitutionVerificationStatus;
  tickPath: TickPath | null;
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
      tickPath: institutions.tickPath,
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

type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

type StaffDecision = {
  institution: VerifyResult["institution"];
  auditEntry: VerificationAuditEntry;
};

type StaffDecisionInput = {
  institutionId: string;
  fromStatus: InstitutionVerificationStatus;
  targetStatus: InstitutionVerificationStatus;
  actor: ResolvedPlatformOpsActor;
  reason: string | null;
};

const STAFF_TICK_CLOSED_REQUEST_NOTE = "Ditutup karena staf memberi centang langsung.";
const TICK_TAKEN_CLOSED_REQUEST_NOTE =
  "Ditutup karena centang ruang kerja dicabut atau ditolak staf. Centang hanya dapat didapat lagi lewat dokumen.";

const toStaffDecision = (written: TickTransitionResult): StaffDecision => ({
  institution: {
    id: written.institution.id,
    verificationStatus: written.institution.verificationStatus,
    verifiedAt: written.institution.verifiedAt,
    rejectedAt: written.institution.rejectedAt,
    rejectionReason: written.institution.rejectionReason,
  },
  auditEntry: {
    id: written.auditEntry.id,
    actorUserId: written.auditEntry.actorUserId,
    fromStatus: written.auditEntry.fromStatus,
    toStatus: written.auditEntry.toStatus,
    reason: written.auditEntry.reason,
    createdAt: written.auditEntry.createdAt,
  },
});

// Staff give the tick directly. A request the owner still had open asked for the same thing, so it
// is closed as approved and its submitter is trusted as an approval would trust it.
const grantStaffTick = async (
  tx: TransactionClient,
  input: StaffDecisionInput,
): Promise<StaffDecision> => {
  const written = await writeTickTransition(tx, {
    institutionId: input.institutionId,
    from: input.fromStatus,
    to: "verified",
    tickPath: "staff",
    tickDomain: null,
    nameState: "cleared",
    actorUserId: input.actor.userId,
    reason: input.reason,
  });

  const closedRequest = await closePendingRequestInTransaction(tx, {
    institutionId: input.institutionId,
    status: "approved",
    reviewerUserId: input.actor.userId,
    reviewerNotes: STAFF_TICK_CLOSED_REQUEST_NOTE,
  });
  if (closedRequest) {
    await trustTickSubmitterInTransaction(tx, input.actor, {
      institutionId: input.institutionId,
      submissionId: closedRequest.id,
      submitterUserId: closedRequest.submittedByUserId,
      requestedPath: closedRequest.requestedPath,
      closedByStaffOverride: true,
    });
  }
  return toStaffDecision(written);
};

// A revocation or a denial. Every tick column is cleared, and a pending Path B request is closed
// because the tick can only come back through documents now. A pending Path C request stays open.
const rejectInstitution = async (
  tx: TransactionClient,
  input: StaffDecisionInput,
): Promise<StaffDecision> => {
  const written = await writeTickTransition(tx, {
    institutionId: input.institutionId,
    from: input.fromStatus,
    to: "rejected",
    tickPath: null,
    tickDomain: null,
    nameState: "cleared",
    actorUserId: input.actor.userId,
    reason: input.reason,
  });

  await closePendingRequestInTransaction(tx, {
    institutionId: input.institutionId,
    status: "rejected",
    reviewerUserId: input.actor.userId,
    reviewerNotes: TICK_TAKEN_CLOSED_REQUEST_NOTE,
    onlyRequestedPath: "instagram",
  });
  return toStaffDecision(written);
};

// A move that neither grants nor takes a tick (a workspace sent to review). Pinned to the status
// the decision was read against, so a decision that raced another one is refused.
const moveStatusOnly = async (
  tx: TransactionClient,
  input: StaffDecisionInput,
): Promise<StaffDecision> => {
  const [updated] = await tx
    .update(institutions)
    .set({ verificationStatus: input.targetStatus, updatedAt: sql`now()` })
    .where(
      and(
        eq(institutions.id, input.institutionId),
        eq(institutions.verificationStatus, input.fromStatus),
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

  const [auditRow] = await tx
    .insert(institutionVerificationAudit)
    .values({
      institutionId: input.institutionId,
      actorUserId: input.actor.userId,
      fromStatus: input.fromStatus,
      toStatus: input.targetStatus,
      reason: input.reason,
    })
    .returning();

  if (!auditRow) {
    throw new Error("Failed to insert verification audit entry");
  }

  return {
    institution: updated,
    auditEntry: {
      id: auditRow.id,
      actorUserId: auditRow.actorUserId,
      fromStatus: auditRow.fromStatus,
      toStatus: auditRow.toStatus,
      reason: auditRow.reason,
      createdAt: auditRow.createdAt,
    },
  };
};

const applyStaffDecision = async (
  tx: TransactionClient,
  input: StaffDecisionInput,
): Promise<StaffDecision> => {
  if (input.targetStatus === "verified") return grantStaffTick(tx, input);
  if (input.targetStatus === "rejected") return rejectInstitution(tx, input);
  return moveStatusOnly(tx, input);
};

// A rejection means two things to the owners: a revocation when the tick was verified before, a
// turn-down of the request otherwise. Moving to under_review notifies nobody.
const noticeKindOfStaffDecision = (
  fromStatus: InstitutionVerificationStatus,
  targetStatus: InstitutionVerificationStatus,
): InstitutionTickNoticeKind | null => {
  if (targetStatus === "verified") return "tick_granted";
  if (targetStatus !== "rejected") return null;
  return fromStatus === "verified" ? "tick_revoked" : "tick_request_turned_down";
};

export const verifyInstitution = async (options: {
  institutionId: string;
  targetStatus: InstitutionVerificationStatus;
  reason?: string;
  actorUserId: string;
  db?: Database;
}): Promise<VerifyResult> => {
  const db = options.db ?? getDb();

  let auditEntry: VerificationAuditEntry;
  let institutionSnapshot: VerifyResult["institution"];
  let current: {
    displayName: string;
    verificationStatus: InstitutionVerificationStatus;
  };

  // Assigned inside the transaction, read by the logger after it commits.
  let resolvedActorUserId: string | null = null;

  await db.transaction(async (tx) => {
    // THE ACTOR IS READ FIRST, AND FROM THE DATABASE (LAUNCH-D72, mirrors
    // recruiter-tier-service.ts:120-129). `options.actorUserId` is whatever the caller claimed; the
    // refusal codes below are about the caller's own account, and the audit row must name the
    // account the database answered with rather than the one that was asserted. Reading it first
    // also means a caller with no business here learns nothing about the target.
    //
    // THE ONLY ROLE AUTHORITY ON THIS PATH (C2.2). The route's `requireSessionRole(["platform_ops"])`
    // gate and this read are the two halves; a role STRING passed in the options object was a third,
    // and a claim. `reviewVerificationSubmission` has been shaped this way since LAUNCH-D72.
    const actor = await resolvePlatformOpsActor(tx, options.actorUserId);
    resolvedActorUserId = actor.userId;

    // Read and write in one transaction, and pin the UPDATE to the status this decision was made
    // against. Two concurrent PATCHes previously both passed assertValidTransition and both
    // committed, leaving the loser's audit row describing a transition that never happened — which
    // matters now that a revocation can race an approval in either direction.
    const [row] = await tx
      .select({
        displayName: institutions.displayName,
        institutionType: institutions.institutionType,
        verificationStatus: institutions.verificationStatus,
        slug: institutions.slug,
      })
      .from(institutions)
      .where(eq(institutions.id, options.institutionId))
      .limit(1);

    if (!row) {
      throw new VerificationError("verification_not_found", 404, "Institution not found");
    }

    // NOBODY DECIDES THEIR OWN INSTITUTION. The three relationships that make an operator conflicted,
    // and why each is read in ANY status, are declared in the rule itself
    // (operator-institution-conflict.ts). It runs here — after the institution read that supplies the
    // id, before the transition is validated and before anything is written — so a refused decision
    // leaves the target's status and audit trail untouched by the attempt.
    await assertOperatorHasNoInstitutionRelationship(tx, actor, options.institutionId);

    current = row;

    assertValidTransition(row.verificationStatus, options.targetStatus);

    const decision = await applyStaffDecision(tx, {
      institutionId: options.institutionId,
      fromStatus: row.verificationStatus,
      targetStatus: options.targetStatus,
      // The RESOLVED actor, not the claimed id.
      actor,
      reason: options.reason ?? null,
    });
    institutionSnapshot = decision.institution;
    auditEntry = decision.auditEntry;
  });

  logger.info("institution.verification.transitioned", {
    institutionId: options.institutionId,
    actorUserId: resolvedActorUserId,
    from: current!.verificationStatus,
    to: options.targetStatus,
    reason: options.reason,
  });

  const noticeKind = noticeKindOfStaffDecision(current!.verificationStatus, options.targetStatus);

  if (noticeKind) {
    const carriesReason = noticeKind !== "tick_granted" && options.reason !== undefined;
    await enqueueTickNoticeAfterCommit({
      institutionId: options.institutionId,
      kind: noticeKind,
      ...(carriesReason ? { reason: options.reason } : {}),
    });
  }

  return {
    institution: institutionSnapshot!,
    auditEntry: auditEntry!,
  };
};
