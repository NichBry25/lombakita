import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  isCompetitionGuidelineCode,
  type CompetitionGuidelineCode,
} from "@/lib/competitions/competition-guidelines";
import { logger } from "@/lib/logger";
import {
  enqueueRecruiterVerificationApproved,
  enqueueRecruiterVerificationRejected,
} from "@/server/async/enqueue";
import { AccessError } from "@/server/auth/access-core";
import {
  assertCompetitionAccess,
  MEMBER_ROLES,
  type CompetitionRow,
} from "@/server/competitions/competition-access";
import { CompetitionError } from "@/server/competitions/competition-core";
import { transitionCompetitionStatus } from "@/server/competitions/competition-service";
import { getDb, type Database } from "@/server/db/client";
import {
  candidateProfiles,
  competitions,
  institutionMemberships,
  institutions,
  recruiterVerificationSubmissions,
  users,
} from "@/server/db/schema";
import {
  trustHostInTransaction,
  wouldTrustHostAutomatically,
} from "@/server/host-trust/host-trust-service";
import { isPublishTrustSatisfied } from "@/server/host-trust/publish-trust";
import {
  OperatorActorError,
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
  type OperatorActorTransaction,
  type ResolvedPlatformOpsActor,
} from "@/server/platform-ops/operator-actor";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/host-check-service");

export type HostCheckStateName =
  | "not_needed"
  | "needed"
  | "pending"
  | "pending_other_draft"
  | "turned_down";

// What the publish control says about the caller's host check for one draft.
export type HostCheckReadout = {
  state: HostCheckStateName;
  competitionTitle?: string;
  guidelineItem?: string;
  note?: string;
};

export type OpenedHostCheck = { id: string; status: "pending_review"; submittedAt: Date };

export type PublishPressResult =
  | { outcome: "published"; competition: CompetitionRow }
  | { outcome: "host_check_opened"; hostCheck: OpenedHostCheck };

type HostCheckContact = { fullName: string; mobileNumber: string };

type OpenHostCheckRow = { id: string; competitionId: string | null; submittedAt: Date };

const OPEN_STATUSES = ["draft", "pending_review"] as const;
const REQUEST_WITHOUT_DRAFT_CLOSE_REASON = "Ditutup karena alur penyelenggara berubah.";
const GONE_DRAFT_CLOSE_REASON = "Ditutup karena draf tidak lagi tersedia.";

// A draft that a host check can still publish: not deleted and still a draft.
const isLiveDraft: SQL = and(isNull(competitions.deletedAt), eq(competitions.status, "draft"))!;

// An open row without competition_id is not a host check, because every host check names its
// draft. It is closed the way migration 0071 closes such rows, so it cannot hold the one open row
// the account may have.
const closeOpenRequestsWithoutDraft = async (tx: Database, userId: string): Promise<void> => {
  await tx
    .update(recruiterVerificationSubmissions)
    .set({
      status: "rejected",
      rejectionReason: REQUEST_WITHOUT_DRAFT_CLOSE_REASON,
      resubmissionAllowed: false,
      reviewedAt: sql`now()`,
    })
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        inArray(recruiterVerificationSubmissions.status, [...OPEN_STATUSES]),
        isNull(recruiterVerificationSubmissions.competitionId),
      ),
    );
};

// A check whose draft was deleted or is no longer a draft can never publish it, so it is closed
// here and never blocks a press on another draft. It names no guideline item, so it never reads as
// a turn-down.
const closeOpenChecksWithoutLiveDraft = async (tx: Database, userId: string): Promise<void> => {
  const liveDraftOfCheck = tx
    .select({ id: competitions.id })
    .from(competitions)
    .where(and(eq(competitions.id, recruiterVerificationSubmissions.competitionId), isLiveDraft));
  await tx
    .update(recruiterVerificationSubmissions)
    .set({
      status: "rejected",
      rejectionReason: GONE_DRAFT_CLOSE_REASON,
      resubmissionAllowed: false,
      reviewedAt: sql`now()`,
    })
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        inArray(recruiterVerificationSubmissions.status, [...OPEN_STATUSES]),
        isNotNull(recruiterVerificationSubmissions.competitionId),
        notExists(liveDraftOfCheck),
      ),
    );
};

// A host check carries the name and phone of sign-up, or else those of the account's newest
// earlier host request, so staff can reach the person they judge.
const readHostCheckContactOrRefuse = async (
  tx: Database,
  userId: string,
): Promise<HostCheckContact> => {
  const [profile] = await tx
    .select({ fullName: candidateProfiles.fullName, mobileNumber: candidateProfiles.phoneNumber })
    .from(candidateProfiles)
    .where(eq(candidateProfiles.userId, userId))
    .limit(1);
  if (profile) return profile;

  const [earlierRequest] = await tx
    .select({
      fullName: recruiterVerificationSubmissions.fullName,
      mobileNumber: recruiterVerificationSubmissions.mobileNumber,
    })
    .from(recruiterVerificationSubmissions)
    .where(eq(recruiterVerificationSubmissions.userId, userId))
    .orderBy(
      desc(recruiterVerificationSubmissions.submittedAt),
      desc(recruiterVerificationSubmissions.id),
    )
    .limit(1);
  if (earlierRequest) return earlierRequest;

  throw new CompetitionError(
    "host_check_contact_missing",
    422,
    "A host check needs a name and a phone number, and this account has neither",
  );
};

const insertOpenHostCheck = async (
  tx: Database,
  userId: string,
  competitionId: string,
  contact: HostCheckContact,
): Promise<OpenedHostCheck | null> => {
  const [inserted] = await tx
    .insert(recruiterVerificationSubmissions)
    .values({ userId, competitionId, ...contact, status: "pending_review" })
    .onConflictDoNothing()
    .returning({
      id: recruiterVerificationSubmissions.id,
      submittedAt: recruiterVerificationSubmissions.submittedAt,
    });
  if (!inserted) return null;
  return { id: inserted.id, status: "pending_review", submittedAt: inserted.submittedAt };
};

const readOpenHostCheck = async (
  tx: Database,
  userId: string,
): Promise<OpenHostCheckRow | null> => {
  const [open] = await tx
    .select({
      id: recruiterVerificationSubmissions.id,
      competitionId: recruiterVerificationSubmissions.competitionId,
      submittedAt: recruiterVerificationSubmissions.submittedAt,
    })
    .from(recruiterVerificationSubmissions)
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        inArray(recruiterVerificationSubmissions.status, [...OPEN_STATUSES]),
      ),
    )
    .limit(1);
  return open ?? null;
};

// The title of another draft is given only while the caller still runs its institution as owner or
// staff, so a person who left a workspace does not keep reading its drafts.
const readTitleOfDraftTheActorRuns = async (
  db: Database,
  actorUserId: string,
  competitionId: string,
): Promise<string | null> => {
  const [draft] = await db
    .select({ title: competitions.title })
    .from(competitions)
    .innerJoin(
      institutionMemberships,
      and(
        eq(institutionMemberships.institutionId, competitions.institutionId),
        eq(institutionMemberships.userId, actorUserId),
        eq(institutionMemberships.status, "active"),
        inArray(institutionMemberships.membershipRole, MEMBER_ROLES),
      ),
    )
    .where(eq(competitions.id, competitionId))
    .limit(1);
  return draft?.title ?? null;
};

const refuseOpenCheckOnOtherDraft = async (
  tx: Database,
  actorUserId: string,
  otherCompetitionId: string | null,
): Promise<never> => {
  const title =
    otherCompetitionId === null
      ? null
      : await readTitleOfDraftTheActorRuns(tx, actorUserId, otherCompetitionId);
  throw new CompetitionError(
    "host_check_pending_other_draft",
    409,
    "Another draft of this account is waiting for its host check",
    title === null ? undefined : { pendingCompetitionTitle: title },
  );
};

// One transaction, so a refusal anywhere in it also rolls back the closes before it.
const openHostCheck = async (
  actorUserId: string,
  competitionId: string,
  db: Database,
): Promise<OpenedHostCheck> =>
  db.transaction(async (tx) => {
    const contact = await readHostCheckContactOrRefuse(tx, actorUserId);
    await closeOpenRequestsWithoutDraft(tx, actorUserId);
    await closeOpenChecksWithoutLiveDraft(tx, actorUserId);

    const opened = await insertOpenHostCheck(tx, actorUserId, competitionId, contact);
    if (opened) return opened;

    // The insert met the one open row this account may hold, read after the conflict.
    const existing = await readOpenHostCheck(tx, actorUserId);
    if (!existing) {
      throw new CompetitionError(
        "competition_invalid_transition",
        422,
        "The open host check changed during this press. Reload and retry",
      );
    }
    if (existing.competitionId !== competitionId) {
      return refuseOpenCheckOnOtherDraft(tx, actorUserId, existing.competitionId);
    }
    return { id: existing.id, status: "pending_review", submittedAt: existing.submittedAt };
  });

const isTrustRefusal = (error: unknown): boolean =>
  error instanceof CompetitionError && error.code === "competition_recruiter_not_trusted";

// The publish press. The access check runs first, so no automatic trust is written for a caller
// who may not publish this competition. Automatic trust runs in its own transaction and takes the
// rows in the order the Email organisasi confirm takes them: host_organization_emails, then users.
// Only the trust refusal opens a host check. Every other refusal reaches the caller unchanged.
export const publishOrOpenHostCheck = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<PublishPressResult> => {
  await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  await db.transaction((tx) => trustHostInTransaction(tx, actorUserId));

  try {
    const { competition } = await transitionCompetitionStatus(
      actorUserId,
      competitionId,
      "published",
      db,
    );
    return { outcome: "published", competition };
  } catch (error) {
    if (!isTrustRefusal(error)) throw error;
  }

  const hostCheck = await openHostCheck(actorUserId, competitionId, db);
  return { outcome: "host_check_opened", hostCheck };
};

const readOpenHostCheckOnLiveDraft = async (
  db: Database,
  userId: string,
): Promise<{ competitionId: string } | null> => {
  const [open] = await db
    .select({ competitionId: competitions.id })
    .from(recruiterVerificationSubmissions)
    .innerJoin(
      competitions,
      and(eq(competitions.id, recruiterVerificationSubmissions.competitionId), isLiveDraft),
    )
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        inArray(recruiterVerificationSubmissions.status, [...OPEN_STATUSES]),
      ),
    )
    .limit(1);
  return open ?? null;
};

// Only a staff decision counts: it names its draft, and a staff turn-down always names a guideline
// item. A request closed without a draft, or a check closed because its draft went away, names no
// guideline item and never reads as a turn-down.
const readNewestStaffDecision = async (db: Database, userId: string) => {
  const [decision] = await db
    .select({
      status: recruiterVerificationSubmissions.status,
      guidelineItem: recruiterVerificationSubmissions.guidelineItem,
      note: recruiterVerificationSubmissions.rejectionReason,
    })
    .from(recruiterVerificationSubmissions)
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        isNotNull(recruiterVerificationSubmissions.competitionId),
        isNotNull(recruiterVerificationSubmissions.reviewedAt),
        or(
          eq(recruiterVerificationSubmissions.status, "approved"),
          and(
            eq(recruiterVerificationSubmissions.status, "rejected"),
            isNotNull(recruiterVerificationSubmissions.guidelineItem),
          ),
        ),
      ),
    )
    .orderBy(
      desc(recruiterVerificationSubmissions.reviewedAt),
      desc(recruiterVerificationSubmissions.id),
    )
    .limit(1);
  return decision ?? null;
};

export const readHostCheckStateForActor = async (
  actorUserId: string,
  competition: Pick<CompetitionRow, "id" | "institutionId">,
  db: Database = getDb(),
): Promise<HostCheckReadout> => {
  if (await isPublishTrustSatisfied(actorUserId, competition.institutionId, db)) {
    return { state: "not_needed" };
  }
  if (await wouldTrustHostAutomatically(db, actorUserId)) return { state: "not_needed" };

  const open = await readOpenHostCheckOnLiveDraft(db, actorUserId);
  if (open?.competitionId === competition.id) return { state: "pending" };
  if (open) {
    const title = await readTitleOfDraftTheActorRuns(db, actorUserId, open.competitionId);
    if (title === null) return { state: "pending_other_draft" };
    return { state: "pending_other_draft", competitionTitle: title };
  }

  const decision = await readNewestStaffDecision(db, actorUserId);
  if (decision === null || decision.status !== "rejected" || decision.guidelineItem === null) {
    return { state: "needed" };
  }
  return {
    state: "turned_down",
    guidelineItem: decision.guidelineItem,
    note: decision.note ?? undefined,
  };
};

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

const toHostCheckQueueEntry = (
  row: OpenHostCheckQueueRow,
  earlierTurnDowns: HostCheckTurnDown[],
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
  return rows.map((row) => toHostCheckQueueEntry(row, turnDownsByHost.get(row.userId) ?? []));
};

export type HostCheckDecisionInput =
  | { decision: "approve" }
  | { decision: "turn_down"; guidelineItem: string; note: string };

export type HostCheckDecisionErrorCode =
  | "host_check_not_found"
  | "host_check_already_decided"
  | "host_check_guideline_required"
  | "host_check_guideline_unknown"
  | "host_check_note_required";

export class HostCheckDecisionError extends Error {
  constructor(
    public readonly code: HostCheckDecisionErrorCode,
    public readonly status: 400 | 404 | 409,
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

type HostCheckTurnDownInput = { guidelineItem: CompetitionGuidelineCode; note: string };

type DecidedHostCheck = { userId: string; competitionId: string };

// Checked before the transaction, so a refused turn-down writes nothing.
const parseTurnDownOrRefuse = (guidelineItem: string, note: string): HostCheckTurnDownInput => {
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
  return { guidelineItem, note: trimmedNote };
};

// Only a row that names its draft is a host check. The email condition keeps a request from an
// address the account never proved out of every decision (DEC-0259).
const decidableHostCheck = (checkId: string): SQL =>
  and(
    eq(recruiterVerificationSubmissions.id, checkId),
    eq(recruiterVerificationSubmissions.status, "pending_review"),
    isNotNull(recruiterVerificationSubmissions.competitionId),
    sql`exists (select 1 from ${users} where ${users.id} = ${recruiterVerificationSubmissions.userId} and ${users.emailVerified} is not null)`,
  )!;

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
    .where(decidableHostCheck(checkId))
    .returning(decidedHostCheckColumns);

const markHostCheckTurnedDown = (
  tx: OperatorActorTransaction,
  checkId: string,
  reviewerUserId: string,
  turnDown: HostCheckTurnDownInput,
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
    .where(decidableHostCheck(checkId))
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

// A compare-and-set from pending_review, so two decisions on one check close it once.
const closeHostCheckOrRefuse = async (
  tx: OperatorActorTransaction,
  checkId: string,
  reviewerUserId: string,
  turnDown: HostCheckTurnDownInput | null,
): Promise<DecidedHostCheck> => {
  const closedRows =
    turnDown === null
      ? await markHostCheckApproved(tx, checkId, reviewerUserId)
      : await markHostCheckTurnedDown(tx, checkId, reviewerUserId, turnDown);
  const [closed] = closedRows;
  if (closed) return closed;
  return refuseUndecidableHostCheck(tx, checkId);
};

// An approval is the staff decision to trust this person, so it also clears a staff trust removal.
const trustApprovedHost = async (tx: OperatorActorTransaction, userId: string): Promise<void> => {
  await tx
    .update(users)
    .set({
      recruiterVerificationTier: "elevated",
      hostTrustRemovedAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(users.id, userId));
};

const recordHostCheckDecisionAudit = async (
  tx: OperatorActorTransaction,
  actor: ResolvedPlatformOpsActor,
  checkId: string,
  check: DecidedHostCheck,
  turnDown: HostCheckTurnDownInput | null,
): Promise<void> => {
  if (turnDown === null) {
    await recordOperatorAuditEntry(tx, actor, {
      targetUserId: check.userId,
      eventType: HOST_CHECK_APPROVED_EVENT,
      metadata: { checkId, competitionId: check.competitionId },
    });
    return;
  }
  await recordOperatorAuditEntry(tx, actor, {
    targetUserId: check.userId,
    eventType: HOST_CHECK_TURNED_DOWN_EVENT,
    reason: turnDown.note,
    metadata: {
      checkId,
      competitionId: check.competitionId,
      guidelineItem: turnDown.guidelineItem,
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
    });
    return false;
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
  turnDown: HostCheckTurnDownInput,
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
// check closes from pending_review once, the actor may not decide its own check, an approval trusts
// the host, and the audit row lands with it. After the commit an approval publishes the check's own
// draft as the host, and the notice goes to the host through the two-channel jobs.
export const decideHostCheck = async (
  staffUserId: string,
  checkId: string,
  input: HostCheckDecisionInput,
  db: Database = getDb(),
): Promise<HostCheckDecisionResult> => {
  const turnDown =
    input.decision === "turn_down" ? parseTurnDownOrRefuse(input.guidelineItem, input.note) : null;

  const check = await db.transaction(async (tx) => {
    const actor = await resolvePlatformOpsActor(tx, staffUserId);
    const closed = await closeHostCheckOrRefuse(tx, checkId, actor.userId, turnDown);
    if (actor.userId === closed.userId) {
      throw new OperatorActorError(
        "operator_actor_is_target",
        403,
        "A platform-ops account cannot decide its own host check",
      );
    }
    if (turnDown === null) await trustApprovedHost(tx, closed.userId);
    await recordHostCheckDecisionAudit(tx, actor, checkId, closed, turnDown);
    return closed;
  });

  if (turnDown !== null) {
    await enqueueTurnDownNotice(checkId, check.userId, turnDown);
    return { id: checkId, userId: check.userId, status: "rejected", published: false };
  }

  const published = await publishApprovedDraftAsHost(check.userId, check.competitionId, db);
  await enqueueApprovalNotice(check.userId, check.competitionId);
  return { id: checkId, userId: check.userId, status: "approved", published };
};

// The staff raise trusts the person a host check judges, so it closes that person's open check as
// approved. It does not publish the draft: the host publishes it with one press.
export const closeOpenHostCheckAsApproved = async (
  tx: Database,
  userId: string,
  reviewerUserId: string,
): Promise<void> => {
  await tx
    .update(recruiterVerificationSubmissions)
    .set({ status: "approved", reviewerUserId, reviewedAt: sql`now()` })
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        eq(recruiterVerificationSubmissions.status, "pending_review"),
        isNotNull(recruiterVerificationSubmissions.competitionId),
      ),
    );
};
