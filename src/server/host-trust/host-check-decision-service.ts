import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  isCompetitionGuidelineCode,
  type CompetitionGuidelineCode,
} from "@/lib/competitions/competition-guidelines";
import { logger } from "@/lib/logger";
import { assertAccountNotDeactivated } from "@/server/accounts/deactivated-account";
import {
  enqueueRecruiterVerificationApproved,
  enqueueRecruiterVerificationRejected,
} from "@/server/async/enqueue";
import { AccessError } from "@/server/auth/access-core";
import { CompetitionError } from "@/server/competitions/competition-core";
import { transitionCompetitionStatus } from "@/server/competitions/competition-service";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  institutions,
  platformOpsAuditLogs,
  recruiterVerificationSubmissions,
  users,
} from "@/server/db/schema";
import {
  GONE_DRAFT_CLOSE_REASON,
  isLiveDraft,
  liveDraftOfCheck,
} from "@/server/host-trust/host-check-drafts";
import { HOST_TRUST_REMOVED_EVENT } from "@/server/host-trust/host-trust-removal-service";
import { liftRemovedHostRecord } from "@/server/host-trust/removed-host-identity";
import {
  OperatorActorError,
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
  type OperatorActorTransaction,
  type ResolvedPlatformOpsActor,
} from "@/server/platform-ops/operator-actor";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/host-check-decision-service");

// The staff side of host checks: the queue, the decision and the close the staff raise runs.

const HOST_CHECK_NOTE_MAX_LENGTH = 1000;
const HOST_CHECK_APPROVED_EVENT = "host_check.approved";
const HOST_CHECK_TURNED_DOWN_EVENT = "host_check.turned_down";

export type HostCheckTurnDown = {
  reviewedAt: Date | null;
  guidelineItem: string;
  note: string | null;
};

type HostCheckDraftFields = Pick<
  typeof competitions.$inferSelect,
  | "title"
  | "description"
  | "category"
  | "mode"
  | "location"
  | "registrationStartAt"
  | "registrationEndAt"
  | "eventStartAt"
  | "eventEndAt"
  | "resultAnnouncementAt"
  | "feeAmount"
  | "feeCurrency"
  | "organizerContactKind"
  | "organizerContactValue"
>;

// One open host check as the staff queue shows it: the person, the draft and the earlier turn-downs.
export type HostCheckQueueEntry = {
  id: string;
  submittedAt: Date;
  overdue: boolean;
  host: {
    userId: string;
    fullName: string;
    mobileNumber: string;
    email: string;
    trustRemovedAt: Date | null;
    trustRemovalReason: string | null;
  };
  draft: HostCheckDraftFields & { competitionId: string; institutionName: string | null };
  earlierTurnDowns: HostCheckTurnDown[];
};

// Open checks on live drafts of accounts with a confirmed email, oldest first. A request without a
// draft joins no competition, so it never shows. A check is overdue after 7 days.
const readOpenHostChecksOnLiveDrafts = (db: Database) =>
  db
    .select({
      id: recruiterVerificationSubmissions.id,
      submittedAt: recruiterVerificationSubmissions.submittedAt,
      overdue: sql<boolean>`${recruiterVerificationSubmissions.submittedAt} < now() - interval '7 days'`,
      userId: recruiterVerificationSubmissions.userId,
      fullName: recruiterVerificationSubmissions.fullName,
      mobileNumber: recruiterVerificationSubmissions.mobileNumber,
      email: users.email,
      trustRemovedAt: users.hostTrustRemovedAt,
      competitionId: competitions.id,
      title: competitions.title,
      description: competitions.description,
      category: competitions.category,
      mode: competitions.mode,
      location: competitions.location,
      registrationStartAt: competitions.registrationStartAt,
      registrationEndAt: competitions.registrationEndAt,
      eventStartAt: competitions.eventStartAt,
      eventEndAt: competitions.eventEndAt,
      resultAnnouncementAt: competitions.resultAnnouncementAt,
      feeAmount: competitions.feeAmount,
      feeCurrency: competitions.feeCurrency,
      organizerContactKind: competitions.organizerContactKind,
      organizerContactValue: competitions.organizerContactValue,
      institutionName: institutions.displayName,
    })
    .from(recruiterVerificationSubmissions)
    .innerJoin(users, eq(users.id, recruiterVerificationSubmissions.userId))
    .innerJoin(
      competitions,
      and(eq(competitions.id, recruiterVerificationSubmissions.competitionId), isLiveDraft),
    )
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(recruiterVerificationSubmissions.status, "pending_review"),
        isNotNull(users.emailVerified),
      ),
    )
    .orderBy(
      asc(recruiterVerificationSubmissions.submittedAt),
      asc(recruiterVerificationSubmissions.id),
    );

type OpenHostCheckQueueRow = Awaited<ReturnType<typeof readOpenHostChecksOnLiveDrafts>>[number];

// Only a staff turn-down names a guideline item, so a request closed without a draft and a check
// closed because its draft went away never show as an earlier turn-down.
const readEarlierTurnDownsByHost = async (
  db: Database,
  userIds: string[],
): Promise<Map<string, HostCheckTurnDown[]>> => {
  const turnDownsByHost = new Map<string, HostCheckTurnDown[]>();
  if (userIds.length === 0) return turnDownsByHost;

  const rows = await db
    .select({
      userId: recruiterVerificationSubmissions.userId,
      reviewedAt: recruiterVerificationSubmissions.reviewedAt,
      guidelineItem: recruiterVerificationSubmissions.guidelineItem,
      note: recruiterVerificationSubmissions.rejectionReason,
    })
    .from(recruiterVerificationSubmissions)
    .where(
      and(
        inArray(recruiterVerificationSubmissions.userId, userIds),
        eq(recruiterVerificationSubmissions.status, "rejected"),
        isNotNull(recruiterVerificationSubmissions.competitionId),
        isNotNull(recruiterVerificationSubmissions.guidelineItem),
      ),
    )
    .orderBy(
      desc(recruiterVerificationSubmissions.reviewedAt),
      desc(recruiterVerificationSubmissions.id),
    );

  for (const row of rows) {
    const turnDowns = turnDownsByHost.get(row.userId) ?? [];
    // The WHERE holds guideline_item not null.
    turnDowns.push({
      reviewedAt: row.reviewedAt,
      guidelineItem: row.guidelineItem!,
      note: row.note,
    });
    turnDownsByHost.set(row.userId, turnDowns);
  }
  return turnDownsByHost;
};

// The reason of each host's newest staff trust removal. removeHostTrust keeps a removal's reason
// only on its audit row, so the queue reads it there.
const readTrustRemovalReasonsByHost = async (
  db: Database,
  userIds: string[],
): Promise<Map<string, string>> => {
  const reasonsByHost = new Map<string, string>();
  if (userIds.length === 0) return reasonsByHost;

  const rows = await db
    .select({ userId: platformOpsAuditLogs.targetUserId, reason: platformOpsAuditLogs.reason })
    .from(platformOpsAuditLogs)
    .where(
      and(
        inArray(platformOpsAuditLogs.targetUserId, userIds),
        eq(platformOpsAuditLogs.eventType, HOST_TRUST_REMOVED_EVENT),
      ),
    )
    .orderBy(desc(platformOpsAuditLogs.createdAt), desc(platformOpsAuditLogs.id));

  for (const row of rows) {
    if (row.userId === null || row.reason === null) continue;
    // The rows come newest first, so the first row of a host is its newest removal.
    if (!reasonsByHost.has(row.userId)) reasonsByHost.set(row.userId, row.reason);
  }
  return reasonsByHost;
};

const toHostCheckQueueEntry = (
  row: OpenHostCheckQueueRow,
  earlierTurnDowns: HostCheckTurnDown[],
  trustRemovalReason: string | null,
): HostCheckQueueEntry => ({
  id: row.id,
  submittedAt: row.submittedAt,
  overdue: row.overdue,
  host: {
    userId: row.userId,
    fullName: row.fullName,
    mobileNumber: row.mobileNumber,
    email: row.email,
    trustRemovedAt: row.trustRemovedAt,
    // A raise or an approval clears the removal and keeps its audit row, so a reason is given only
    // while the removal stands.
    trustRemovalReason: row.trustRemovedAt === null ? null : trustRemovalReason,
  },
  draft: {
    competitionId: row.competitionId,
    title: row.title,
    description: row.description,
    category: row.category,
    mode: row.mode,
    location: row.location,
    registrationStartAt: row.registrationStartAt,
    registrationEndAt: row.registrationEndAt,
    eventStartAt: row.eventStartAt,
    eventEndAt: row.eventEndAt,
    resultAnnouncementAt: row.resultAnnouncementAt,
    feeAmount: row.feeAmount,
    feeCurrency: row.feeCurrency,
    organizerContactKind: row.organizerContactKind,
    organizerContactValue: row.organizerContactValue,
    institutionName: row.institutionName,
  },
  earlierTurnDowns,
});

// The staff host check queue. It only reads, so the route's role gate is its access check.
export const listHostChecks = async (db: Database = getDb()): Promise<HostCheckQueueEntry[]> => {
  const rows = await readOpenHostChecksOnLiveDrafts(db);
  const hostIds = rows.map((row) => row.userId);
  const turnDownsByHost = await readEarlierTurnDownsByHost(db, hostIds);
  const removalReasonsByHost = await readTrustRemovalReasonsByHost(db, hostIds);
  return rows.map((row) =>
    toHostCheckQueueEntry(
      row,
      turnDownsByHost.get(row.userId) ?? [],
      removalReasonsByHost.get(row.userId) ?? null,
    ),
  );
};

const HOST_CHECK_CLOSED_WITHOUT_DRAFT_EVENT = "host_check.closed_without_draft";
const HOST_CHECK_APPROVAL_PUBLISH_EVENT = "host_check.approval_publish";

export type HostCheckDecisionInput =
  | { decision: "approve" }
  | { decision: "turn_down"; guidelineItem: string; note: string };

export type HostCheckDecisionErrorCode =
  | "host_check_not_found"
  | "host_check_already_decided"
  | "host_check_guideline_required"
  | "host_check_guideline_unknown"
  | "host_check_note_required"
  | "host_check_target_not_host"
  | "account_deactivated";

export class HostCheckDecisionError extends Error {
  constructor(
    public readonly code: HostCheckDecisionErrorCode,
    public readonly status: 400 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

export type HostCheckDecisionResult = {
  id: string;
  userId: string;
  status: "approved" | "rejected";
  published: boolean;
};

type CheckedTurnDown = {
  decision: "turn_down";
  guidelineItem: CompetitionGuidelineCode;
  note: string;
};

// A decision whose input passed its checks: an approval, or a turn-down with a known guideline item
// and a trimmed note.
type CheckedHostCheckDecision = { decision: "approve" } | CheckedTurnDown;

// The check a decision closed. draftGone is true when its draft was deleted or is no longer a draft,
// and the decision then closed it the way the press closes such a check.
type ClosedHostCheck = { userId: string; competitionId: string; draftGone: boolean };

// Checked before the transaction, so a refused turn-down writes nothing.
const checkDecisionOrRefuse = (input: HostCheckDecisionInput): CheckedHostCheckDecision => {
  if (input.decision === "approve") return input;
  const { guidelineItem, note } = input;
  if (guidelineItem.trim() === "") {
    throw new HostCheckDecisionError(
      "host_check_guideline_required",
      400,
      "A turn-down names the guideline item the draft does not meet",
    );
  }
  if (!isCompetitionGuidelineCode(guidelineItem)) {
    throw new HostCheckDecisionError(
      "host_check_guideline_unknown",
      400,
      "The guideline item is not one of the competition guidelines",
    );
  }
  const trimmedNote = note.trim();
  if (trimmedNote.length === 0 || trimmedNote.length > HOST_CHECK_NOTE_MAX_LENGTH) {
    throw new HostCheckDecisionError(
      "host_check_note_required",
      400,
      "A turn-down carries a note of 1 to 1000 characters",
    );
  }
  return { decision: "turn_down", guidelineItem, note: trimmedNote };
};

// Only a row that names its draft is a host check. The email condition keeps a request from an
// address the account never proved out of every decision (DEC-0259).
const openHostCheckOfConfirmedHost = (checkId: string): SQL =>
  and(
    eq(recruiterVerificationSubmissions.id, checkId),
    eq(recruiterVerificationSubmissions.status, "pending_review"),
    isNotNull(recruiterVerificationSubmissions.competitionId),
    sql`exists (select 1 from ${users} where ${users.id} = ${recruiterVerificationSubmissions.userId} and ${users.emailVerified} is not null)`,
  )!;

// Staff approve or turn down only a check whose draft is still live.
const decidableHostCheck = (tx: OperatorActorTransaction, checkId: string): SQL =>
  and(openHostCheckOfConfirmedHost(checkId), exists(liveDraftOfCheck(tx)))!;

const decidedHostCheckColumns = {
  userId: recruiterVerificationSubmissions.userId,
  competitionId: sql<string>`${recruiterVerificationSubmissions.competitionId}`,
};

const markHostCheckApproved = (
  tx: OperatorActorTransaction,
  checkId: string,
  reviewerUserId: string,
) =>
  tx
    .update(recruiterVerificationSubmissions)
    .set({ status: "approved", reviewerUserId, reviewedAt: sql`now()` })
    .where(decidableHostCheck(tx, checkId))
    .returning(decidedHostCheckColumns);

const markHostCheckTurnedDown = (
  tx: OperatorActorTransaction,
  checkId: string,
  reviewerUserId: string,
  turnDown: CheckedTurnDown,
) =>
  tx
    .update(recruiterVerificationSubmissions)
    .set({
      status: "rejected",
      reviewerUserId,
      reviewedAt: sql`now()`,
      guidelineItem: turnDown.guidelineItem,
      rejectionReason: turnDown.note,
      resubmissionAllowed: false,
    })
    .where(decidableHostCheck(tx, checkId))
    .returning(decidedHostCheckColumns);

// A check whose draft was deleted or is no longer a draft can never publish it. A decision on it
// closes it with the press's reason and names no guideline item, so it never reads as a turn-down.
const markHostCheckClosedWithoutDraft = (
  tx: OperatorActorTransaction,
  checkId: string,
  reviewerUserId: string,
) =>
  tx
    .update(recruiterVerificationSubmissions)
    .set({
      status: "rejected",
      reviewerUserId,
      reviewedAt: sql`now()`,
      rejectionReason: GONE_DRAFT_CLOSE_REASON,
      resubmissionAllowed: false,
    })
    .where(and(openHostCheckOfConfirmedHost(checkId), notExists(liveDraftOfCheck(tx))))
    .returning(decidedHostCheckColumns);

// No row closed: the id names no decidable host check, or staff already closed it.
const refuseUndecidableHostCheck = async (
  tx: OperatorActorTransaction,
  checkId: string,
): Promise<never> => {
  const [existing] = await tx
    .select({ id: recruiterVerificationSubmissions.id })
    .from(recruiterVerificationSubmissions)
    .innerJoin(users, eq(users.id, recruiterVerificationSubmissions.userId))
    .where(
      and(
        eq(recruiterVerificationSubmissions.id, checkId),
        isNotNull(recruiterVerificationSubmissions.competitionId),
        isNotNull(users.emailVerified),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new HostCheckDecisionError("host_check_not_found", 404, "Host check not found");
  }
  throw new HostCheckDecisionError(
    "host_check_already_decided",
    409,
    "This host check already has a staff decision",
  );
};

// The host's users row is locked before the check row, in the order the staff raise takes them, so
// an approval and a raise of one host never wait on each other in a cycle. A de-identified host is
// refused here, as the raise refuses one.
const lockHostOfCheck = async (tx: OperatorActorTransaction, checkId: string): Promise<void> => {
  const [check] = await tx
    .select({ userId: recruiterVerificationSubmissions.userId })
    .from(recruiterVerificationSubmissions)
    .where(eq(recruiterVerificationSubmissions.id, checkId))
    .limit(1);
  if (!check) return;
  await assertAccountNotDeactivated(tx, check.userId, HostCheckDecisionError);
};

// A compare-and-set from pending_review, so two decisions on one check close it once. The two
// closes match opposite rows, a check on a live draft and a check whose draft went away.
const closeHostCheckOrRefuse = async (
  tx: OperatorActorTransaction,
  checkId: string,
  reviewerUserId: string,
  decision: CheckedHostCheckDecision,
): Promise<ClosedHostCheck> => {
  const [closedOnLiveDraft] =
    decision.decision === "approve"
      ? await markHostCheckApproved(tx, checkId, reviewerUserId)
      : await markHostCheckTurnedDown(tx, checkId, reviewerUserId, decision);
  if (closedOnLiveDraft) return { ...closedOnLiveDraft, draftGone: false };

  const [closedWithoutDraft] = await markHostCheckClosedWithoutDraft(tx, checkId, reviewerUserId);
  if (closedWithoutDraft) return { ...closedWithoutDraft, draftGone: true };

  return refuseUndecidableHostCheck(tx, checkId);
};

// An approval is the staff decision to trust this person, so it also clears a staff trust removal
// and deletes its record.
// An account without the host role is refused, as the staff raise refuses one.
const trustApprovedHost = async (tx: OperatorActorTransaction, userId: string): Promise<void> => {
  const trustedRows = await tx
    .update(users)
    .set({
      recruiterVerificationTier: "elevated",
      hostTrustRemovedAt: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(users.id, userId), isNotNull(users.recruiterVerifiedAt)))
    .returning({ id: users.id });
  if (trustedRows.length > 0) {
    await liftRemovedHostRecord(tx, userId);
    return;
  }
  throw new HostCheckDecisionError(
    "host_check_target_not_host",
    422,
    "The account does not hold the host role and cannot be trusted",
  );
};

const recordHostCheckDecisionAudit = async (
  tx: OperatorActorTransaction,
  actor: ResolvedPlatformOpsActor,
  checkId: string,
  closed: ClosedHostCheck,
  decision: CheckedHostCheckDecision,
): Promise<void> => {
  if (closed.draftGone) {
    await recordOperatorAuditEntry(tx, actor, {
      targetUserId: closed.userId,
      eventType: HOST_CHECK_CLOSED_WITHOUT_DRAFT_EVENT,
      metadata: { checkId, competitionId: closed.competitionId },
    });
    return;
  }
  if (decision.decision === "approve") {
    await recordOperatorAuditEntry(tx, actor, {
      targetUserId: closed.userId,
      eventType: HOST_CHECK_APPROVED_EVENT,
      metadata: { checkId, competitionId: closed.competitionId },
    });
    return;
  }
  await recordOperatorAuditEntry(tx, actor, {
    targetUserId: closed.userId,
    eventType: HOST_CHECK_TURNED_DOWN_EVENT,
    reason: decision.note,
    metadata: {
      checkId,
      competitionId: closed.competitionId,
      guidelineItem: decision.guidelineItem,
    },
  });
};

const refusalCodeOf = (error: unknown): string => {
  if (error instanceof CompetitionError) return error.code;
  if (error instanceof AccessError) return error.code;
  return "unexpected_error";
};

// The decision has committed, so a refusal here leaves the account trusted and the draft a draft.
// The notice then tells the host to publish it.
const publishApprovedDraftAsHost = async (
  hostUserId: string,
  competitionId: string,
  db: Database,
): Promise<boolean> => {
  try {
    await transitionCompetitionStatus(hostUserId, competitionId, "published", db);
    return true;
  } catch (error) {
    logger.warn("host_check.approval_publish_refused", {
      hostUserId,
      competitionId,
      code: refusalCodeOf(error),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

// The publish runs after the decision commits, so whether the draft went live is a second audit row,
// written in its own transaction. A failure here is logged and never undoes the decision.
const recordApprovalPublishAudit = async (
  staffUserId: string,
  checkId: string,
  check: ClosedHostCheck,
  published: boolean,
  db: Database,
): Promise<void> => {
  try {
    await db.transaction(async (tx) => {
      const actor = await resolvePlatformOpsActor(tx, staffUserId);
      await recordOperatorAuditEntry(tx, actor, {
        targetUserId: check.userId,
        eventType: HOST_CHECK_APPROVAL_PUBLISH_EVENT,
        metadata: { checkId, competitionId: check.competitionId, published },
      });
    });
  } catch (error) {
    logger.warn("host_check.approval_publish_audit_failed", {
      checkId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Sent after the commit and never awaited into a failure: a failed enqueue never undoes a decision.
const enqueueApprovalNotice = async (userId: string, competitionId: string): Promise<void> => {
  try {
    await enqueueRecruiterVerificationApproved({ userId, competitionId, epoch: Date.now() });
  } catch (error) {
    logger.warn("host_check.approval_notice_enqueue_failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const enqueueTurnDownNotice = async (
  checkId: string,
  userId: string,
  turnDown: CheckedTurnDown,
): Promise<void> => {
  try {
    await enqueueRecruiterVerificationRejected({
      submissionId: checkId,
      userId,
      rejectionReason: turnDown.note,
      resubmissionAllowed: false,
      guidelineItem: turnDown.guidelineItem,
      epoch: Date.now(),
    });
  } catch (error) {
    logger.warn("host_check.turn_down_notice_enqueue_failed", {
      checkId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// The staff decision on a host check. One transaction: the platform_ops actor is read first, the
// host's row is locked and a de-identified host refused, the check closes from pending_review once,
// and the actor may not decide its own check. On a live draft an approval trusts the host, and the
// audit row lands with the close. After the commit an approval publishes the check's own draft as
// the host, a second audit row records whether it went live, and the notice goes to the host through
// the two-channel jobs. A check whose draft went away gets no trust, no publish and no notice.
export const decideHostCheck = async (
  staffUserId: string,
  checkId: string,
  input: HostCheckDecisionInput,
  db: Database = getDb(),
): Promise<HostCheckDecisionResult> => {
  const decision = checkDecisionOrRefuse(input);

  const check = await db.transaction(async (tx) => {
    const actor = await resolvePlatformOpsActor(tx, staffUserId);
    await lockHostOfCheck(tx, checkId);
    const closed = await closeHostCheckOrRefuse(tx, checkId, actor.userId, decision);
    if (actor.userId === closed.userId) {
      throw new OperatorActorError(
        "operator_actor_is_target",
        403,
        "A platform-ops account cannot decide its own host check",
      );
    }
    if (decision.decision === "approve" && !closed.draftGone) {
      await trustApprovedHost(tx, closed.userId);
    }
    await recordHostCheckDecisionAudit(tx, actor, checkId, closed, decision);
    return closed;
  });

  if (check.draftGone) {
    return { id: checkId, userId: check.userId, status: "rejected", published: false };
  }
  if (decision.decision === "turn_down") {
    await enqueueTurnDownNotice(checkId, check.userId, decision);
    return { id: checkId, userId: check.userId, status: "rejected", published: false };
  }

  const published = await publishApprovedDraftAsHost(check.userId, check.competitionId, db);
  await recordApprovalPublishAudit(staffUserId, checkId, check, published, db);
  await enqueueApprovalNotice(check.userId, check.competitionId);
  return { id: checkId, userId: check.userId, status: "approved", published };
};

// The staff raise trusts the person a host check judges, so it closes that person's open check as
// approved and returns its id, or null when none was open. It does not publish the draft: the host
// publishes it with one press.
export const closeOpenHostCheckAsApproved = async (
  tx: Database,
  userId: string,
  reviewerUserId: string,
): Promise<string | null> => {
  const [closed] = await tx
    .update(recruiterVerificationSubmissions)
    .set({ status: "approved", reviewerUserId, reviewedAt: sql`now()` })
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        eq(recruiterVerificationSubmissions.status, "pending_review"),
        isNotNull(recruiterVerificationSubmissions.competitionId),
      ),
    )
    .returning({ id: recruiterVerificationSubmissions.id });
  return closed?.id ?? null;
};
