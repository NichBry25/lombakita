import { desc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { platformOpsNotes, users } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { assertAccountNotDeactivated } from "@/server/accounts/deactivated-account";
import {
  assertOperatorHasNoInstitutionRelationship,
  OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
} from "@/server/institution-verification/operator-institution-conflict";
import { ModerationError } from "@/server/moderation/moderation-core";
import {
  OperatorActorError,
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
} from "@/server/platform-ops/operator-actor";

assertServerOnly("server/moderation/notes-service");

// Creating a note needs no audit row — the note itself records its author and time. Only an edit
// destroys prior state, so only an edit is audited.
export const NOTE_EDITED_EVENT = "platform_ops_note.edited";

export type NoteTarget = {
  targetUserId?: string | null;
  targetInstitutionId?: string | null;
};

export type PlatformOpsNote = {
  id: string;
  note: string;
  createdById: string;
  createdByName: string | null;
  createdAt: Date;
};

// Exactly one of (targetUserId, targetInstitutionId) must be present — mirrors the DB XOR CHECK.
const resolveSingleTarget = (
  target: NoteTarget,
): { targetUserId: string | null; targetInstitutionId: string | null } => {
  const userId = target.targetUserId ?? null;
  const institutionId = target.targetInstitutionId ?? null;
  const hasUser = typeof userId === "string" && userId.length > 0;
  const hasInstitution = typeof institutionId === "string" && institutionId.length > 0;

  if (hasUser === hasInstitution) {
    throw new ModerationError(
      "invalid_note_target",
      400,
      "Exactly one of targetUserId or targetInstitutionId is required",
    );
  }

  return {
    targetUserId: hasUser ? userId : null,
    targetInstitutionId: hasInstitution ? institutionId : null,
  };
};

export const addNote = async (
  actorUserId: string,
  input: NoteTarget & { note: string },
  db: Database = getDb(),
): Promise<PlatformOpsNote> => {
  const { targetUserId, targetInstitutionId } = resolveSingleTarget(input);

  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length === 0) {
    throw new ModerationError("note_required", 400, "Note text is required");
  }

  // One transaction so the deactivation check and the insert cannot interleave with a
  // de-identification running against the same account. A note about an institution is not a note
  // about a person, so the guard only applies to the user-target shape.
  const [row] = await db.transaction(async (tx) => {
    if (targetUserId !== null) {
      await assertAccountNotDeactivated(tx, targetUserId, ModerationError);
    }

    return tx
      .insert(platformOpsNotes)
      .values({ targetUserId, targetInstitutionId, note, createdById: actorUserId })
      .returning({
        id: platformOpsNotes.id,
        note: platformOpsNotes.note,
        createdById: platformOpsNotes.createdById,
        createdAt: platformOpsNotes.createdAt,
      });
  });

  if (!row) {
    throw new Error("Failed to insert platform ops note");
  }

  return { ...row, createdByName: null };
};

export const editNote = async (
  actorUserId: string,
  noteId: string,
  newText: string,
  db: Database = getDb(),
): Promise<PlatformOpsNote> => {
  const trimmed = typeof newText === "string" ? newText.trim() : "";
  if (trimmed.length === 0) {
    throw new ModerationError("note_required", 400, "Note text is required");
  }

  // An edit overwrites the note in place, and any platform_ops actor may edit any note regardless
  // of who wrote it. Without this the replaced text would be unrecoverable and the fact that
  // someone else rewrote another operator's note would leave no trace at all. The previous text is
  // captured in the audit row, in the same transaction as the overwrite.
  //
  // The actor is resolved from the database first, and may not edit a note written about their own
  // account or about an institution they are tied to (LAUNCH-D136).
  const [row] = await db.transaction(async (tx) => {
    const actor = await resolvePlatformOpsActor(tx, actorUserId);

    const [existing] = await tx
      .select({
        id: platformOpsNotes.id,
        note: platformOpsNotes.note,
        createdById: platformOpsNotes.createdById,
        targetUserId: platformOpsNotes.targetUserId,
        targetInstitutionId: platformOpsNotes.targetInstitutionId,
      })
      .from(platformOpsNotes)
      .where(eq(platformOpsNotes.id, noteId))
      .limit(1);

    if (!existing) {
      throw new ModerationError("note_not_found", 404, "Note not found");
    }

    if (existing.targetUserId === actor.userId) {
      throw new OperatorActorError(
        "operator_actor_is_target",
        403,
        "A platform-ops account cannot edit a note written about it",
      );
    }

    if (existing.targetInstitutionId !== null) {
      await assertOperatorHasNoInstitutionRelationship(
        tx,
        actor,
        existing.targetInstitutionId,
        OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
      );
    }

    const updated = await tx
      .update(platformOpsNotes)
      .set({ note: trimmed })
      .where(eq(platformOpsNotes.id, noteId))
      .returning({
        id: platformOpsNotes.id,
        note: platformOpsNotes.note,
        createdById: platformOpsNotes.createdById,
        createdAt: platformOpsNotes.createdAt,
      });

    if (updated.length > 0) {
      await recordOperatorAuditEntry(tx, actor, {
        // The note's own XOR target carries over, satisfying the audit table's target CHECK.
        targetUserId: existing.targetUserId,
        targetInstitutionId: existing.targetInstitutionId,
        eventType: NOTE_EDITED_EVENT,
        metadata: {
          noteId,
          previousNote: existing.note,
          noteAuthorId: existing.createdById,
        },
      });
    }

    return updated;
  });

  if (!row) throw new Error("Failed to update platform ops note");
  return { ...row, createdByName: null };
};

export const listNotes = async (
  target: NoteTarget,
  db: Database = getDb(),
): Promise<PlatformOpsNote[]> => {
  const { targetUserId, targetInstitutionId } = resolveSingleTarget(target);

  const whereClause = targetUserId
    ? eq(platformOpsNotes.targetUserId, targetUserId)
    : eq(platformOpsNotes.targetInstitutionId, targetInstitutionId as string);

  return db
    .select({
      id: platformOpsNotes.id,
      note: platformOpsNotes.note,
      createdById: platformOpsNotes.createdById,
      createdByName: users.name,
      createdAt: platformOpsNotes.createdAt,
    })
    .from(platformOpsNotes)
    .leftJoin(users, eq(users.id, platformOpsNotes.createdById))
    .where(whereClause)
    .orderBy(desc(platformOpsNotes.createdAt));
};
