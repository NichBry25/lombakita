import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { absoluteSiteUrl } from "@/config/site-url";
import { logger } from "@/lib/logger";
import type { InstitutionTickNoticePayload } from "@/server/async/contracts";
import { enqueueInstitutionTickNotice } from "@/server/async/enqueue";
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
import { automaticTrustEligibility } from "@/server/host-trust/host-trust-service";
import { findRemovedHostMatch } from "@/server/host-trust/removed-host-identity";
import { assertOperatorHasNoInstitutionRelationship } from "@/server/institution-verification/operator-institution-conflict";
import {
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
} from "@/server/platform-ops/operator-actor";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { closePendingRequestInTransaction, readTickClosure } from "./tick-service";
import {
  removeTickAutomatically,
  TICK_REMOVED_NAME_PROOF,
  writeTickTransition,
  type TickNameState,
} from "./tick-transition";
import { VerificationError } from "./verification-core";

assertServerOnly("server/institution-verification/name-check-service");

type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

const MAX_REASON_LENGTH = 1000;
const OVERDUE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const PROOF_REQUESTED_CLOSES_PATH_B_NOTE =
  "Ditutup karena staf meminta bukti nama. Bukti nama hanya dapat dikirim lewat dokumen.";
const REMOVAL_CLOSES_PATH_B_NOTE =
  "Ditutup karena centang ruang kerja dicabut otomatis. Centang hanya dapat didapat lagi lewat dokumen.";

export type NameCheckDecision =
  | { decision: "name_ok"; reason?: string }
  | { decision: "require_proof"; reason: string };

export type NameCheckResult = {
  institutionId: string;
  decision: "name_ok" | "require_proof";
  nameCheckedAt: Date | null;
  nameProofDueAt: Date | null;
};

export type NameProofSweepResult = {
  reminded: string[];
  reminderEnqueueFailed: string[];
  removed: string[];
  removalMissed: string[];
  removalFailed: string[];
};

export type TickQueueClosure = { cause: "staff" | "automatic"; closedInstitutionId: string };

export type TickQueueRequest = {
  submissionId: string;
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  requestedPath: "instagram" | "documents";
  instagramUrl: string | null;
  pageUrl: string;
  submittedByUserId: string;
  submitterEmail: string | null;
  submitterWouldBeTrusted: boolean;
  submittedAt: Date;
  overdue: boolean;
  documentCount: number;
  closure: TickQueueClosure | null;
  lastLeftVerified: {
    toStatus: InstitutionVerificationStatus;
    reason: string | null;
    actorUserId: string | null;
    createdAt: Date;
  } | null;
  siblingClosures: TickQueueClosure[];
};

export type TickQueueNameCheck = {
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  tickDomain: string | null;
  ownerEmailDomains: string[];
  paidDraft: {
    competitionId: string;
    title: string;
    feeAmount: number;
    feeCurrency: string | null;
  };
  since: Date;
  siblingClosures: TickQueueClosure[];
};

export type TickQueueProof = {
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  nameProofDueAt: Date;
  reminded: boolean;
};

export type TickQueue = {
  requests: TickQueueRequest[];
  nameChecks: TickQueueNameCheck[];
  runningProofs: TickQueueProof[];
};

const errorTextOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isTransitionConflict = (error: unknown): error is VerificationError =>
  error instanceof VerificationError && error.code === "verification_transition_conflict";

// The due date as exact UTC text with microseconds, which the notice job compares with the column in
// SQL. A JavaScript Date keeps only milliseconds.
const NAME_PROOF_DUE_TEXT_SQL = sql<string>`to_char(${institutions.nameProofDueAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const NAME_PROOF_DUE_EPOCH_SECONDS_SQL = sql<number>`floor(extract(epoch from ${institutions.nameProofDueAt}))::float8`;

// The sweep compares with the time it was given, never the database clock, so a test passes `now`.
const timestampOf = (now: Date): SQL => sql`${now.toISOString()}::timestamptz`;

// Sent after the commit and never awaited into a failure: a failed enqueue never undoes a decision.
export const enqueueTickNoticeAfterCommit = async (
  notice: Omit<InstitutionTickNoticePayload, "epoch">,
): Promise<void> => {
  try {
    await enqueueInstitutionTickNotice({ payload: { ...notice, epoch: Date.now() } });
  } catch (error) {
    logger.error("institution_tick.notice_enqueue_failed", {
      institutionId: notice.institutionId,
      kind: notice.kind,
      error: errorTextOf(error),
    });
  }
};

const refuseReasonLength = (): VerificationError =>
  new VerificationError(
    "institution_name_check_reason_invalid",
    400,
    "reason must be 1 to 1000 characters",
  );

// The reason is trimmed and never cut. A require_proof needs one, and no decision takes more than
// 1000 characters.
const trimmedReasonOrRefuse = (input: NameCheckDecision): string | null => {
  const trimmed = input.reason?.trim() ?? "";
  if (trimmed.length > MAX_REASON_LENGTH) throw refuseReasonLength();
  if (input.decision === "require_proof" && trimmed.length === 0) throw refuseReasonLength();
  return trimmed.length === 0 ? null : trimmed;
};

const refuseNotApplicable = (): VerificationError =>
  new VerificationError(
    "institution_name_check_not_applicable",
    409,
    "This workspace has no organization email tick whose name staff can check",
  );

const refuseProofRunning = (): VerificationError =>
  new VerificationError(
    "institution_name_proof_running",
    409,
    "A name proof is already running for this workspace",
  );

const refuseReasonRequired = (): VerificationError =>
  new VerificationError(
    "institution_name_check_reason_required",
    422,
    "A name proof is running, so accepting the name needs a reason",
  );

const readCheckedInstitution = async (tx: TransactionClient, institutionId: string) => {
  const [row] = await tx
    .select({
      verificationStatus: institutions.verificationStatus,
      tickPath: institutions.tickPath,
      tickDomain: institutions.tickDomain,
      nameProofDueAt: institutions.nameProofDueAt,
    })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);
  if (!row) {
    throw new VerificationError("verification_not_found", 404, "Institution not found");
  }
  return row;
};

const refuseUnlessOrganizationEmailTick = (row: {
  verificationStatus: InstitutionVerificationStatus;
  tickPath: string | null;
}): void => {
  if (row.verificationStatus !== "verified") throw refuseNotApplicable();
  if (row.tickPath !== "domain") throw refuseNotApplicable();
};

const refuseProofGuards = (
  input: NameCheckDecision,
  reason: string | null,
  proofRuns: boolean,
): void => {
  if (input.decision === "require_proof" && proofRuns) throw refuseProofRunning();
  if (input.decision === "name_ok" && proofRuns && reason === null) throw refuseReasonRequired();
};

// The write is pinned so that an approval, a proof request or a name decision that commits between
// the read and the write makes it match nothing.
const buildNameCheckExtraWhere = (input: NameCheckDecision, reason: string | null): SQL => {
  const onOrganizationEmailTick = eq(institutions.tickPath, "domain");
  if (input.decision === "require_proof") {
    return and(onOrganizationEmailTick, isNull(institutions.nameProofDueAt))!;
  }
  if (reason === null) {
    return and(onOrganizationEmailTick, isNull(institutions.nameProofDueAt))!;
  }
  return onOrganizationEmailTick;
};

const nameStateOf = (input: NameCheckDecision): TickNameState =>
  input.decision === "name_ok" ? "checked" : "proofStarted";

const readProofRuns = async (tx: TransactionClient, institutionId: string): Promise<boolean> => {
  const [row] = await tx
    .select({ nameProofDueAt: institutions.nameProofDueAt })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);
  return (row?.nameProofDueAt ?? null) !== null;
};

// A miss that came from a proof the decision raced is reported as that proof, and any other miss as
// the conflict.
const explainNameDecisionMiss = async (
  tx: TransactionClient,
  institutionId: string,
  input: NameCheckDecision,
  reason: string | null,
  conflict: VerificationError,
): Promise<never> => {
  const proofRunsNow = await readProofRuns(tx, institutionId);
  if (input.decision === "name_ok" && reason === null && proofRunsNow) {
    throw refuseReasonRequired();
  }
  if (input.decision === "require_proof" && proofRunsNow) throw refuseProofRunning();
  throw conflict;
};

const writeNameDecision = async (
  tx: TransactionClient,
  input: NameCheckDecision,
  reason: string | null,
  institutionId: string,
  actorUserId: string,
  tickDomain: string | null,
) => {
  try {
    return await writeTickTransition(tx, {
      institutionId,
      from: "verified",
      to: "verified",
      tickPath: "domain",
      tickDomain,
      nameState: nameStateOf(input),
      actorUserId,
      reason,
      extraWhere: buildNameCheckExtraWhere(input, reason),
    });
  } catch (error) {
    if (!isTransitionConflict(error)) throw error;
    return explainNameDecisionMiss(tx, institutionId, input, reason, error);
  }
};

const readNameProofDueText = async (
  tx: TransactionClient,
  institutionId: string,
): Promise<string | undefined> => {
  const [row] = await tx
    .select({ dueText: NAME_PROOF_DUE_TEXT_SQL })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);
  return row?.dueText ?? undefined;
};

const decideNameCheckInTransaction = async (
  tx: TransactionClient,
  staffUserId: string,
  institutionId: string,
  input: NameCheckDecision,
  reason: string | null,
): Promise<{ result: NameCheckResult; dueAt: string | undefined }> => {
  const actor = await resolvePlatformOpsActor(tx, staffUserId);
  const row = await readCheckedInstitution(tx, institutionId);
  await assertOperatorHasNoInstitutionRelationship(tx, actor, institutionId);
  refuseUnlessOrganizationEmailTick(row);
  refuseProofGuards(input, reason, row.nameProofDueAt !== null);

  const written = await writeNameDecision(
    tx,
    input,
    reason,
    institutionId,
    actor.userId,
    row.tickDomain,
  );

  let dueAt: string | undefined;
  if (input.decision === "require_proof") {
    await closePendingRequestInTransaction(tx, {
      institutionId,
      status: "rejected",
      reviewerUserId: actor.userId,
      reviewerNotes: PROOF_REQUESTED_CLOSES_PATH_B_NOTE,
      onlyRequestedPath: "instagram",
    });
    dueAt = await readNameProofDueText(tx, institutionId);
  }

  await recordOperatorAuditEntry(tx, actor, {
    targetInstitutionId: institutionId,
    eventType:
      input.decision === "name_ok"
        ? "institution_tick.name_checked"
        : "institution_tick.name_proof_requested",
    reason,
  });

  return {
    result: {
      institutionId,
      decision: input.decision,
      nameCheckedAt: written.institution.nameCheckedAt,
      nameProofDueAt: written.institution.nameProofDueAt,
    },
    dueAt,
  };
};

// The staff decision on the name of a workspace ticked by its organization email: the name is fine,
// or the owners must prove it within 28 days. One transaction: the platform_ops actor is read first,
// the operator may not hold any relationship to the workspace, and the write is one pinned update
// with its audit rows. After the commit the owners are told through the two-channel notice job.
export const decideNameCheck = async (
  staffUserId: string,
  institutionId: string,
  input: NameCheckDecision,
  db: Database = getDb(),
): Promise<NameCheckResult> => {
  const reason = trimmedReasonOrRefuse(input);

  const { result, dueAt } = await db.transaction((tx) =>
    decideNameCheckInTransaction(tx, staffUserId, institutionId, input, reason),
  );

  if (input.decision === "name_ok") {
    await enqueueTickNoticeAfterCommit({ institutionId, kind: "name_checked" });
    return result;
  }

  await enqueueTickNoticeAfterCommit({
    institutionId,
    kind: "name_proof_requested",
    ...(reason === null ? {} : { reason }),
    ...(dueAt === undefined ? {} : { dueAt }),
  });
  return result;
};

type DueProofRow = { id: string; dueAt: string; dueEpochSeconds: number };

const selectProofsDueForReminder = async (now: Date, db: Database): Promise<DueProofRow[]> => {
  const rows = await db
    .select({
      id: institutions.id,
      dueAt: NAME_PROOF_DUE_TEXT_SQL,
      dueEpochSeconds: NAME_PROOF_DUE_EPOCH_SECONDS_SQL,
    })
    .from(institutions)
    .where(
      and(
        eq(institutions.verificationStatus, "verified"),
        eq(institutions.tickPath, "domain"),
        isNotNull(institutions.nameProofDueAt),
        isNull(institutions.nameProofRemindedAt),
        sql`${institutions.nameProofDueAt} - interval '7 days' <= ${timestampOf(now)}`,
      ),
    )
    .orderBy(asc(institutions.id));
  return rows.map((row) => ({ ...row, dueEpochSeconds: Number(row.dueEpochSeconds) }));
};

// The marker is written only after the enqueue returned, so a failed enqueue is tried again at the
// next sweep. The pin on the exact due text makes a proof that ended or restarted in between match
// nothing.
const markReminderSent = async (row: DueProofRow, db: Database): Promise<boolean> => {
  const marked = await db
    .update(institutions)
    .set({ nameProofRemindedAt: sql`now()` })
    .where(
      and(
        eq(institutions.id, row.id),
        isNull(institutions.nameProofRemindedAt),
        eq(institutions.tickPath, "domain"),
        sql`${institutions.nameProofDueAt} = ${row.dueAt}::timestamptz`,
      ),
    )
    .returning({ id: institutions.id });
  return marked.length > 0;
};

const sendNameProofReminders = async (
  now: Date,
  db: Database,
  result: NameProofSweepResult,
): Promise<void> => {
  const dueRows = await selectProofsDueForReminder(now, db);

  for (const row of dueRows) {
    try {
      await enqueueInstitutionTickNotice({
        payload: {
          institutionId: row.id,
          kind: "name_proof_reminder",
          dueAt: row.dueAt,
          epoch: Date.now(),
        },
        dueEpochSeconds: row.dueEpochSeconds,
      });
    } catch (error) {
      logger.error("name_proof.reminder_enqueue_failed", {
        institutionId: row.id,
        error: errorTextOf(error),
      });
      result.reminderEnqueueFailed.push(row.id);
      continue;
    }

    try {
      const wrote = await markReminderSent(row, db);
      if (wrote) result.reminded.push(row.id);
    } catch (error) {
      logger.error("name_proof.reminder_mark_failed", {
        institutionId: row.id,
        error: errorTextOf(error),
      });
    }
  }
};

const nameProofRunsOut = (now: Date): SQL =>
  sql`${institutions.nameProofDueAt} <= ${timestampOf(now)}`;

// A request for documents sent before the due time is decided by staff first. A request for
// Instagram never holds the removal, because a name proof is documents only.
const NO_DOCUMENTS_REQUEST_SENT_BEFORE_DUE: SQL = sql`NOT EXISTS (
  SELECT 1 FROM institution_verification_submissions pending_request
  WHERE pending_request.institution_id = institutions.id
    AND pending_request.status = 'pending_review'
    AND pending_request.requested_path = 'documents'
    AND pending_request.submitted_at < institutions.name_proof_due_at
)`;

const removalDueConditions = (now: Date): SQL =>
  and(nameProofRunsOut(now), NO_DOCUMENTS_REQUEST_SENT_BEFORE_DUE)!;

const selectProofsDueForRemoval = async (now: Date, db: Database): Promise<DueProofRow[]> => {
  const rows = await db
    .select({
      id: institutions.id,
      dueAt: NAME_PROOF_DUE_TEXT_SQL,
      dueEpochSeconds: NAME_PROOF_DUE_EPOCH_SECONDS_SQL,
    })
    .from(institutions)
    .where(
      and(
        eq(institutions.verificationStatus, "verified"),
        eq(institutions.tickPath, "domain"),
        removalDueConditions(now),
      ),
    )
    .orderBy(asc(institutions.id));
  return rows.map((row) => ({ ...row, dueEpochSeconds: Number(row.dueEpochSeconds) }));
};

// Pinned to the proof as it was read, so a document approval, a name decision or a staff rename that
// commits between the read and the write makes the update match nothing and the tick stays.
const buildRemovalExtraWhere = (row: DueProofRow, now: Date): SQL =>
  and(
    eq(institutions.tickPath, "domain"),
    sql`${institutions.nameProofDueAt} = ${row.dueAt}::timestamptz`,
    removalDueConditions(now),
  )!;

type RemovalOutcome = "removed" | "missed";

// The pending Instagram request is closed in the removal's own transaction, and only when the
// removal wrote its row.
const removeTickOfRunOutProof = async (
  row: DueProofRow,
  now: Date,
  db: Database,
): Promise<RemovalOutcome> => {
  try {
    await db.transaction(async (tx) => {
      await removeTickAutomatically(tx, {
        institutionId: row.id,
        actorUserId: null,
        reason: TICK_REMOVED_NAME_PROOF,
        extraWhere: buildRemovalExtraWhere(row, now),
      });
      await closePendingRequestInTransaction(tx, {
        institutionId: row.id,
        status: "rejected",
        reviewerUserId: null,
        reviewerNotes: REMOVAL_CLOSES_PATH_B_NOTE,
        onlyRequestedPath: "instagram",
      });
    });
    return "removed";
  } catch (error) {
    if (isTransitionConflict(error)) return "missed";
    throw error;
  }
};

const enqueueRemovalNotice = async (row: DueProofRow): Promise<void> => {
  try {
    await enqueueInstitutionTickNotice({
      payload: {
        institutionId: row.id,
        kind: "tick_removed_name_proof",
        dueAt: row.dueAt,
        epoch: Date.now(),
      },
      dueEpochSeconds: row.dueEpochSeconds,
    });
  } catch (error) {
    logger.error("name_proof.removal_notice_enqueue_failed", {
      institutionId: row.id,
      error: errorTextOf(error),
    });
  }
};

const removeTicksOfRunOutProofs = async (
  now: Date,
  db: Database,
  result: NameProofSweepResult,
): Promise<void> => {
  const dueRows = await selectProofsDueForRemoval(now, db);

  for (const row of dueRows) {
    let outcome: RemovalOutcome;
    try {
      outcome = await removeTickOfRunOutProof(row, now, db);
    } catch (error) {
      logger.error("name_proof.removal_failed", {
        institutionId: row.id,
        error: errorTextOf(error),
      });
      result.removalFailed.push(row.id);
      continue;
    }

    if (outcome === "missed") {
      logger.warn("name_proof.removal_skipped", { institutionId: row.id, reason: "tick_changed" });
      result.removalMissed.push(row.id);
      continue;
    }

    result.removed.push(row.id);
    await enqueueRemovalNotice(row);
  }
};

// The hourly sweep of running name proofs: one reminder 7 days before the end, and on the first sweep
// after the end the tick goes by itself unless documents sent before the end wait for staff. One
// workspace failing never stops the others.
export const sweepNameProofs = async (
  now: Date,
  db: Database = getDb(),
): Promise<NameProofSweepResult> => {
  const result: NameProofSweepResult = {
    reminded: [],
    reminderEnqueueFailed: [],
    removed: [],
    removalMissed: [],
    removalFailed: [],
  };

  await sendNameProofReminders(now, db, result);
  await removeTicksOfRunOutProofs(now, db, result);

  return result;
};

const toQueueClosure = (
  closure: Awaited<ReturnType<typeof readTickClosure>>,
): TickQueueClosure | null => {
  if (!closure.closed) return null;
  return { cause: closure.cause, closedInstitutionId: closure.closedInstitutionId };
};

// Every other workspace where an active owner of this one is an active owner and whose tick is
// closed, because the same people holding a closed workspace is what staff weigh before a tick.
const readSiblingClosures = async (
  tx: TransactionClient,
  institutionId: string,
): Promise<TickQueueClosure[]> => {
  const otherMembership = alias(institutionMemberships, "other_membership");
  const siblings = await tx
    .selectDistinct({ institutionId: otherMembership.institutionId })
    .from(institutionMemberships)
    .innerJoin(otherMembership, eq(otherMembership.userId, institutionMemberships.userId))
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.membershipRole, "institution_owner"),
        eq(institutionMemberships.status, "active"),
        eq(otherMembership.membershipRole, "institution_owner"),
        eq(otherMembership.status, "active"),
        sql`${otherMembership.institutionId} <> ${institutionId}`,
      ),
    )
    .orderBy(asc(otherMembership.institutionId));

  const closures: TickQueueClosure[] = [];
  for (const sibling of siblings) {
    const closure = toQueueClosure(await readTickClosure(tx, sibling.institutionId));
    if (closure) closures.push(closure);
  }
  return closures;
};

const readLastLeftVerified = async (tx: TransactionClient, institutionId: string) => {
  const [row] = await tx
    .select({
      toStatus: institutionVerificationAudit.toStatus,
      reason: institutionVerificationAudit.reason,
      actorUserId: institutionVerificationAudit.actorUserId,
      createdAt: institutionVerificationAudit.createdAt,
    })
    .from(institutionVerificationAudit)
    .where(
      and(
        eq(institutionVerificationAudit.institutionId, institutionId),
        eq(institutionVerificationAudit.fromStatus, "verified"),
        sql`${institutionVerificationAudit.toStatus} <> 'verified'`,
      ),
    )
    .orderBy(desc(institutionVerificationAudit.createdAt), desc(institutionVerificationAudit.id))
    .limit(1);
  return row ?? null;
};

const pageUrlOf = (slug: string): string => absoluteSiteUrl(`/institution/${slug}`);

// The submitters who are still active owners of the workspace they filed for, meet the condition
// that trusts a host automatically and match no host whose trust staff removed, which is what a
// tick approval would apply. The match is read after eligibility, so an account the approval would
// not trust never needs the hash key.
const readTrustedSubmitterKeys = async (
  tx: TransactionClient,
  pairs: Array<{ institutionId: string; userId: string }>,
): Promise<Set<string>> => {
  if (pairs.length === 0) return new Set();

  const eligible = await tx
    .select({ institutionId: institutionMemberships.institutionId, userId: users.id })
    .from(institutionMemberships)
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(
      and(
        inArray(
          institutionMemberships.institutionId,
          pairs.map((pair) => pair.institutionId),
        ),
        inArray(
          institutionMemberships.userId,
          pairs.map((pair) => pair.userId),
        ),
        eq(institutionMemberships.membershipRole, "institution_owner"),
        eq(institutionMemberships.status, "active"),
        automaticTrustEligibility,
      ),
    );
  const trusted = new Set<string>();
  for (const row of eligible) {
    const removedHostMatch = await findRemovedHostMatch(tx, row.userId);
    if (removedHostMatch === null) trusted.add(`${row.institutionId}:${row.userId}`);
  }
  return trusted;
};

const listPendingRequests = async (
  tx: TransactionClient,
  now: Date,
): Promise<TickQueueRequest[]> => {
  const rows = await tx
    .select({
      submissionId: institutionVerificationSubmissions.id,
      institutionId: institutions.id,
      institutionSlug: institutions.slug,
      displayName: institutions.displayName,
      requestedPath: institutionVerificationSubmissions.requestedPath,
      instagramUrl: institutionVerificationSubmissions.instagramUrl,
      submittedByUserId: institutionVerificationSubmissions.submittedByUserId,
      submitterEmail: users.email,
      submittedAt: institutionVerificationSubmissions.submittedAt,
      documentCount: sql<number>`(
        SELECT count(*)::int FROM institution_verification_documents ivd
        WHERE ivd.submission_id = institution_verification_submissions.id
      )`,
    })
    .from(institutionVerificationSubmissions)
    .innerJoin(institutions, eq(institutions.id, institutionVerificationSubmissions.institutionId))
    .leftJoin(users, eq(users.id, institutionVerificationSubmissions.submittedByUserId))
    .where(eq(institutionVerificationSubmissions.status, "pending_review"))
    .orderBy(asc(institutionVerificationSubmissions.submittedAt), asc(institutions.id));

  const trustedKeys = await readTrustedSubmitterKeys(
    tx,
    rows.flatMap((row) =>
      row.submittedByUserId === null
        ? []
        : [{ institutionId: row.institutionId, userId: row.submittedByUserId }],
    ),
  );
  const overdueBefore = now.getTime() - OVERDUE_AFTER_DAYS * DAY_MS;

  const requests: TickQueueRequest[] = [];
  for (const row of rows) {
    requests.push({
      submissionId: row.submissionId,
      institutionId: row.institutionId,
      institutionSlug: row.institutionSlug,
      institutionDisplayName: row.displayName,
      // The CHECK on requested_path leaves instagram and documents.
      requestedPath: row.requestedPath === "instagram" ? "instagram" : "documents",
      instagramUrl: row.instagramUrl,
      pageUrl: pageUrlOf(row.institutionSlug),
      submittedByUserId: row.submittedByUserId ?? "",
      submitterEmail: row.submitterEmail,
      submitterWouldBeTrusted: trustedKeys.has(`${row.institutionId}:${row.submittedByUserId}`),
      submittedAt: row.submittedAt,
      overdue: row.submittedAt.getTime() <= overdueBefore,
      documentCount: row.documentCount,
      closure: toQueueClosure(await readTickClosure(tx, row.institutionId)),
      lastLeftVerified: await readLastLeftVerified(tx, row.institutionId),
      siblingClosures: await readSiblingClosures(tx, row.institutionId),
    });
  }
  return requests;
};

// The distinct, ascending domains of the Email organisasi of every active owner, by workspace.
const readOwnerEmailDomains = async (
  tx: TransactionClient,
  institutionIds: string[],
): Promise<Map<string, string[]>> => {
  const domainsByInstitution = new Map<string, string[]>();
  if (institutionIds.length === 0) return domainsByInstitution;

  const rows = await tx
    .selectDistinct({
      institutionId: institutionMemberships.institutionId,
      domain: hostOrganizationEmails.domain,
    })
    .from(institutionMemberships)
    .innerJoin(
      hostOrganizationEmails,
      eq(hostOrganizationEmails.userId, institutionMemberships.userId),
    )
    .where(
      and(
        inArray(institutionMemberships.institutionId, institutionIds),
        eq(institutionMemberships.membershipRole, "institution_owner"),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .orderBy(asc(hostOrganizationEmails.domain));

  for (const row of rows) {
    const domains = domainsByInstitution.get(row.institutionId) ?? [];
    domains.push(row.domain);
    domainsByInstitution.set(row.institutionId, domains);
  }
  return domainsByInstitution;
};

const PAID_DRAFT: SQL = and(
  eq(competitions.status, "draft"),
  isNull(competitions.deletedAt),
  gt(competitions.feeAmount, 0),
)!;

const listNameChecksDue = async (tx: TransactionClient): Promise<TickQueueNameCheck[]> => {
  const rows = await tx
    .selectDistinctOn([institutions.id], {
      institutionId: institutions.id,
      institutionSlug: institutions.slug,
      displayName: institutions.displayName,
      tickDomain: institutions.tickDomain,
      competitionId: competitions.id,
      title: competitions.title,
      feeAmount: competitions.feeAmount,
      feeCurrency: competitions.feeCurrency,
      draftCreatedAt: competitions.createdAt,
    })
    .from(institutions)
    .innerJoin(competitions, eq(competitions.institutionId, institutions.id))
    .where(
      and(
        eq(institutions.verificationStatus, "verified"),
        eq(institutions.tickPath, "domain"),
        isNull(institutions.nameCheckedAt),
        isNull(institutions.nameProofDueAt),
        PAID_DRAFT,
      ),
    )
    .orderBy(asc(institutions.id), asc(competitions.createdAt), asc(competitions.id));

  rows.sort(
    (left, right) =>
      left.draftCreatedAt.getTime() - right.draftCreatedAt.getTime() ||
      left.institutionId.localeCompare(right.institutionId),
  );

  const domainsByInstitution = await readOwnerEmailDomains(
    tx,
    rows.map((row) => row.institutionId),
  );

  const nameChecks: TickQueueNameCheck[] = [];
  for (const row of rows) {
    nameChecks.push({
      institutionId: row.institutionId,
      institutionSlug: row.institutionSlug,
      institutionDisplayName: row.displayName,
      tickDomain: row.tickDomain,
      ownerEmailDomains: domainsByInstitution.get(row.institutionId) ?? [],
      paidDraft: {
        competitionId: row.competitionId,
        title: row.title,
        feeAmount: row.feeAmount ?? 0,
        feeCurrency: row.feeCurrency,
      },
      since: row.draftCreatedAt,
      siblingClosures: await readSiblingClosures(tx, row.institutionId),
    });
  }
  return nameChecks;
};

const listRunningProofs = async (tx: TransactionClient): Promise<TickQueueProof[]> => {
  const rows = await tx
    .select({
      institutionId: institutions.id,
      institutionSlug: institutions.slug,
      displayName: institutions.displayName,
      nameProofDueAt: institutions.nameProofDueAt,
      nameProofRemindedAt: institutions.nameProofRemindedAt,
    })
    .from(institutions)
    .where(
      and(
        eq(institutions.verificationStatus, "verified"),
        eq(institutions.tickPath, "domain"),
        isNotNull(institutions.nameProofDueAt),
      ),
    )
    .orderBy(asc(institutions.nameProofDueAt), asc(institutions.id));

  return rows.flatMap((row) =>
    row.nameProofDueAt === null
      ? []
      : [
          {
            institutionId: row.institutionId,
            institutionSlug: row.institutionSlug,
            institutionDisplayName: row.displayName,
            nameProofDueAt: row.nameProofDueAt,
            reminded: row.nameProofRemindedAt !== null,
          },
        ],
  );
};

// The staff read of the Centang queue. It reads only, and every list is built from the database at
// the time of the read: pending requests for Instagram or documents, ticked workspaces whose name
// waits for a check because a paid draft is waiting, and the running name proofs.
export const listTickQueue = async (db: Database = getDb()): Promise<TickQueue> => {
  const now = new Date();

  return db.transaction(async (tx) => ({
    requests: await listPendingRequests(tx, now),
    nameChecks: await listNameChecksDue(tx),
    runningProofs: await listRunningProofs(tx),
  }));
};
