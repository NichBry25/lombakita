import {
  and,
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
  recruiterVerificationSubmissions,
  users,
} from "@/server/db/schema";
import {
  automaticTrustEligibility,
  isPublishTrustSatisfied,
  resolveAutomaticTrustSource,
  trustHostInTransaction,
} from "@/server/host-trust/host-trust-service";
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

// Whether the press's own trust step would trust this account. It reads the eligibility that
// trustHostInTransaction reads, so a host whose trust staff removed reads as needing a check.
const wouldTrustAutomatically = async (db: Database, userId: string): Promise<boolean> => {
  const [eligibleAccount] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), automaticTrustEligibility))
    .limit(1);
  if (!eligibleAccount) return false;

  const source = await resolveAutomaticTrustSource(db, userId);
  return source !== null;
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
  if (await wouldTrustAutomatically(db, actorUserId)) return { state: "not_needed" };

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
