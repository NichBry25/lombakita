import { eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { institutions } from "@/server/db/schema";
import { enqueueTickNoticeAfterCommit } from "@/server/institution-verification/name-check-service";
import {
  assertOperatorHasNoInstitutionRelationship,
  OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
} from "@/server/institution-verification/operator-institution-conflict";
import { writeTickTransition } from "@/server/institution-verification/tick-transition";
import { VerificationError } from "@/server/institution-verification/verification-core";
import {
  InstitutionWorkspaceInputError,
  parseInstitutionWorkspaceSettingsPatch,
} from "@/server/institution-workspace/institution-core";
import {
  assertSlugNotTakenByUsername,
  buildWorkspaceSettingsUpdates,
  writeWorkspaceSettingsRow,
} from "@/server/institution-workspace/institution-service";
import {
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
} from "@/server/platform-ops/operator-actor";
import {
  enqueueSearchSyncForCompetitions,
  readCompetitionIdsOf,
} from "@/server/search/institution-search-resync";

type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

const MAX_REASON_LENGTH = 1000;

export type RenameInstitutionAsStaffInput = {
  displayName?: unknown;
  slug?: unknown;
  reason: string;
};

export type RenameInstitutionAsStaffResult = {
  institutionId: string;
  displayName: string | null;
  slug: string;
};

type InstitutionBeforeRename = {
  displayName: string | null;
  slug: string;
  description: string | null;
  verificationStatus: string;
  tickPath: string | null;
  tickDomain: string | null;
};

type RenameOutcome = {
  result: RenameInstitutionAsStaffResult;
  changed: boolean;
  reason: string;
  competitionIds: string[];
};

// A plain read without FOR UPDATE. A FOR UPDATE read would wait for a tick decision that holds the
// row and then read the moved tick path, so the pinned write below could never miss.
const readInstitutionBeforeRename = async (
  tx: TransactionClient,
  institutionId: string,
): Promise<InstitutionBeforeRename> => {
  const [row] = await tx
    .select({
      displayName: institutions.displayName,
      slug: institutions.slug,
      description: institutions.description,
      verificationStatus: institutions.verificationStatus,
      tickPath: institutions.tickPath,
      tickDomain: institutions.tickDomain,
    })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);
  if (!row) {
    throw new VerificationError("verification_not_found", 404, "Institution not found");
  }
  return row;
};

const trimmedReasonOrRefuse = (reason: string): string => {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH) {
    throw new InstitutionWorkspaceInputError(
      "institution_rename_reason_required",
      "reason must be 1 to 1000 characters",
      { fields: ["reason"] },
      400,
    );
  }
  return trimmed;
};

const settingsPayloadOf = (input: RenameInstitutionAsStaffInput): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  if (input.displayName !== undefined) payload.displayName = input.displayName;
  if (input.slug !== undefined) payload.slug = input.slug;
  return payload;
};

// Staff chose the name, so a Path A tick keeps its tick, its name counts as checked and a running
// name proof ends. The write is pinned to tick_path domain, so an approval that moved the tick off
// that path first makes it miss and roll the whole rename back.
const markNameCheckedOnPathATick = async (
  tx: TransactionClient,
  row: InstitutionBeforeRename,
  institutionId: string,
  actorUserId: string,
  reason: string,
): Promise<void> => {
  if (row.verificationStatus !== "verified" || row.tickPath !== "domain") return;

  await writeTickTransition(tx, {
    institutionId,
    from: "verified",
    to: "verified",
    tickPath: "domain",
    tickDomain: row.tickDomain,
    nameState: "checked",
    actorUserId,
    reason,
    extraWhere: eq(institutions.tickPath, "domain"),
  });
};

const renameInstitutionInTransaction = async (
  tx: TransactionClient,
  staffUserId: string,
  institutionId: string,
  input: RenameInstitutionAsStaffInput,
): Promise<RenameOutcome> => {
  const actor = await resolvePlatformOpsActor(tx, staffUserId);
  const row = await readInstitutionBeforeRename(tx, institutionId);
  await assertOperatorHasNoInstitutionRelationship(
    tx,
    actor,
    institutionId,
    OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
  );
  const reason = trimmedReasonOrRefuse(input.reason);

  const patch = parseInstitutionWorkspaceSettingsPatch(settingsPayloadOf(input));
  const updates = buildWorkspaceSettingsUpdates(patch, row);
  if (Object.keys(updates).length === 0) {
    const unchanged = { institutionId, displayName: row.displayName, slug: row.slug };
    return { result: unchanged, changed: false, reason, competitionIds: [] };
  }

  if (updates.slug !== undefined) {
    await assertSlugNotTakenByUsername(updates.slug, tx);
  }

  updates.updatedAt = sql`now()`;
  await writeWorkspaceSettingsRow(tx, institutionId, updates);

  await markNameCheckedOnPathATick(tx, row, institutionId, actor.userId, reason);

  const competitionIds = await readCompetitionIdsOf(tx, [institutionId]);
  const result = {
    institutionId,
    displayName: updates.displayName ?? row.displayName,
    slug: updates.slug ?? row.slug,
  };

  await recordOperatorAuditEntry(tx, actor, {
    targetInstitutionId: institutionId,
    eventType: "institution.renamed_by_staff",
    reason,
    metadata: {
      from: { displayName: row.displayName, slug: row.slug },
      to: { displayName: result.displayName, slug: result.slug },
    },
  });

  return { result, changed: true, reason, competitionIds };
};

// Platform staff rename a workspace or change its address, with a reason. One transaction: the
// platform_ops actor is read first, the operator may not hold any relationship to the workspace,
// and the rename, the tick effect and the audit row commit together. After the commit the owners
// are told and the search documents of every competition of the workspace are rewritten.
export const renameInstitutionAsStaff = async (
  staffUserId: string,
  institutionId: string,
  input: RenameInstitutionAsStaffInput,
  db: Database = getDb(),
): Promise<RenameInstitutionAsStaffResult> => {
  const outcome = await db.transaction((tx) =>
    renameInstitutionInTransaction(tx, staffUserId, institutionId, input),
  );
  if (!outcome.changed) return outcome.result;

  await enqueueTickNoticeAfterCommit({
    institutionId,
    kind: "renamed_by_staff",
    reason: outcome.reason,
  });
  enqueueSearchSyncForCompetitions(outcome.competitionIds);
  return outcome.result;
};
