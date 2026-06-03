import { desc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { platformOpsNotes, users } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { ModerationError } from "@/server/moderation/moderation-core";

assertServerOnly("server/moderation/notes-service");

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

  const [row] = await db
    .insert(platformOpsNotes)
    .values({ targetUserId, targetInstitutionId, note, createdById: actorUserId })
    .returning({
      id: platformOpsNotes.id,
      note: platformOpsNotes.note,
      createdById: platformOpsNotes.createdById,
      createdAt: platformOpsNotes.createdAt,
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

  const [existing] = await db
    .select({ id: platformOpsNotes.id, createdById: platformOpsNotes.createdById })
    .from(platformOpsNotes)
    .where(eq(platformOpsNotes.id, noteId))
    .limit(1);

  if (!existing) {
    throw new ModerationError("note_not_found", 404, "Note not found");
  }

  const [row] = await db
    .update(platformOpsNotes)
    .set({ note: trimmed })
    .where(eq(platformOpsNotes.id, noteId))
    .returning({
      id: platformOpsNotes.id,
      note: platformOpsNotes.note,
      createdById: platformOpsNotes.createdById,
      createdAt: platformOpsNotes.createdAt,
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
