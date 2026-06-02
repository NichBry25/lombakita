import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { institutions, platformOpsAuditLogs, users } from "@/server/db/schema";
import type { AppRole } from "@/lib/access/roles";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  assertReasonProvided,
  MODERATION_EVENT,
  ModerationError,
} from "@/server/moderation/moderation-core";

assertServerOnly("server/moderation/moderation-service");

// Internal ops/staff roles that must never be suspendable by the moderation tool. Read from the
// live DB `users.role` (not the session) so the guard holds for any future non-route caller.
// finance_ops is protected alongside platform_ops — both are internal privileged accounts, not
// consumer accounts the moderation surface is designed to act on.
const NON_SUSPENDABLE_ROLES: readonly AppRole[] = ["platform_ops", "finance_ops"];

export type UserModerationResult = {
  userId: string;
  suspendedAt: string | null;
  suspensionReason: string | null;
};

export type InstitutionModerationResult = {
  institutionId: string;
  suspendedAt: string | null;
  suspensionReason: string | null;
};

// Suspends a user account with immediate effect. platform_ops accounts are NOT suspendable — this
// guard lives here at the service layer (not only at the route) so any future caller is bound by
// it. State mutation and the audit-log write share one transaction.
export const suspendUser = async (
  actorUserId: string,
  targetUserId: string,
  reason: string,
  db: Database = getDb(),
): Promise<UserModerationResult> => {
  const cleanReason = assertReasonProvided(reason);

  const [target] = await db
    .select({ id: users.id, role: users.role, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!target) {
    throw new ModerationError("user_not_found", 404, "User not found");
  }
  if (NON_SUSPENDABLE_ROLES.includes(target.role)) {
    throw new ModerationError(
      "cannot_suspend_platform_ops",
      403,
      "Internal ops accounts (platform_ops / finance_ops) cannot be suspended",
    );
  }
  if (target.suspendedAt) {
    throw new ModerationError("user_already_suspended", 409, "User is already suspended");
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ suspendedAt: now, suspensionReason: cleanReason, updatedAt: now })
      .where(eq(users.id, targetUserId));
    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      targetUserId,
      eventType: MODERATION_EVENT.userSuspended,
      reason: cleanReason,
    });
  });

  logger.info("moderation.user_suspended", { actorUserId, targetUserId });
  return { userId: targetUserId, suspendedAt: now.toISOString(), suspensionReason: cleanReason };
};

// Reinstates a suspended user. Clears both suspension fields. 409 if the user is not suspended.
export const unsuspendUser = async (
  actorUserId: string,
  targetUserId: string,
  reason: string,
  db: Database = getDb(),
): Promise<UserModerationResult> => {
  const cleanReason = assertReasonProvided(reason);

  const [target] = await db
    .select({ id: users.id, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!target) {
    throw new ModerationError("user_not_found", 404, "User not found");
  }
  if (!target.suspendedAt) {
    throw new ModerationError("user_not_suspended", 409, "User is not currently suspended");
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ suspendedAt: null, suspensionReason: null, updatedAt: now })
      .where(eq(users.id, targetUserId));
    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      targetUserId,
      eventType: MODERATION_EVENT.userUnsuspended,
      reason: cleanReason,
    });
  });

  logger.info("moderation.user_unsuspended", { actorUserId, targetUserId });
  return { userId: targetUserId, suspendedAt: null, suspensionReason: null };
};

// Suspends an institution. Operational gate distinct from verification_status — a verified
// institution may be suspended. Reinstatement restores operations without touching verification.
export const suspendInstitution = async (
  actorUserId: string,
  targetInstitutionId: string,
  reason: string,
  db: Database = getDb(),
): Promise<InstitutionModerationResult> => {
  const cleanReason = assertReasonProvided(reason);

  const [target] = await db
    .select({ id: institutions.id, suspendedAt: institutions.suspendedAt })
    .from(institutions)
    .where(eq(institutions.id, targetInstitutionId))
    .limit(1);

  if (!target) {
    throw new ModerationError("institution_not_found", 404, "Institution not found");
  }
  if (target.suspendedAt) {
    throw new ModerationError(
      "institution_already_suspended",
      409,
      "Institution is already suspended",
    );
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(institutions)
      .set({ suspendedAt: now, suspensionReason: cleanReason, updatedAt: now })
      .where(eq(institutions.id, targetInstitutionId));
    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      targetInstitutionId,
      eventType: MODERATION_EVENT.institutionSuspended,
      reason: cleanReason,
    });
  });

  logger.info("moderation.institution_suspended", { actorUserId, targetInstitutionId });
  return {
    institutionId: targetInstitutionId,
    suspendedAt: now.toISOString(),
    suspensionReason: cleanReason,
  };
};

// Reinstates a suspended institution. Restores operations (competition create/publish) without
// changing verification_status. 409 if not suspended.
export const reinstateInstitution = async (
  actorUserId: string,
  targetInstitutionId: string,
  reason: string,
  db: Database = getDb(),
): Promise<InstitutionModerationResult> => {
  const cleanReason = assertReasonProvided(reason);

  const [target] = await db
    .select({ id: institutions.id, suspendedAt: institutions.suspendedAt })
    .from(institutions)
    .where(eq(institutions.id, targetInstitutionId))
    .limit(1);

  if (!target) {
    throw new ModerationError("institution_not_found", 404, "Institution not found");
  }
  if (!target.suspendedAt) {
    throw new ModerationError(
      "institution_not_suspended",
      409,
      "Institution is not currently suspended",
    );
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(institutions)
      .set({ suspendedAt: null, suspensionReason: null, updatedAt: now })
      .where(eq(institutions.id, targetInstitutionId));
    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      targetInstitutionId,
      eventType: MODERATION_EVENT.institutionReinstated,
      reason: cleanReason,
    });
  });

  logger.info("moderation.institution_reinstated", { actorUserId, targetInstitutionId });
  return { institutionId: targetInstitutionId, suspendedAt: null, suspensionReason: null };
};
