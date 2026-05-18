import { and, eq, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionAuditLogs,
  institutionMemberships,
  users,
  type InstitutionMembershipRole,
} from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { MemberError, type MemberRecord } from "@/server/institution-members/member-core";

assertServerOnly("server/institution-members/member-service");

// Verifies the calling user has an active institution_owner membership for the given institutionId.
// Reusable across all three member management routes.
export const requireAdminInstitutionById = async (
  actorUserId: string,
  institutionId: string,
  db: Database,
): Promise<void> => {
  const [row] = await db
    .select({ id: institutionMemberships.id })
    .from(institutionMemberships)
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.userId, actorUserId),
        eq(institutionMemberships.membershipRole, "institution_owner"),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (!row) {
    throw new AccessError("forbidden", 403, "institution_owner access required");
  }
};

export const listActiveMembers = async (
  actorUserId: string,
  institutionId: string,
  db: Database = getDb(),
): Promise<MemberRecord[]> => {
  await requireAdminInstitutionById(actorUserId, institutionId, db);

  return db
    .select({
      membershipId: institutionMemberships.id,
      userId: institutionMemberships.userId,
      name: users.name,
      email: users.email,
      role: institutionMemberships.membershipRole,
      joinedAt: institutionMemberships.joinedAt,
    })
    .from(institutionMemberships)
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .orderBy(institutionMemberships.joinedAt);
};

export const changeMemberRole = async (
  actorUserId: string,
  institutionId: string,
  membershipId: string,
  newRole: InstitutionMembershipRole,
  db: Database = getDb(),
): Promise<void> => {
  await requireAdminInstitutionById(actorUserId, institutionId, db);

  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: institutionMemberships.id,
        userId: institutionMemberships.userId,
        role: institutionMemberships.membershipRole,
        status: institutionMemberships.status,
      })
      .from(institutionMemberships)
      .where(
        and(
          eq(institutionMemberships.id, membershipId),
          eq(institutionMemberships.institutionId, institutionId),
          eq(institutionMemberships.status, "active"),
        ),
      )
      .limit(1);

    if (!target) {
      throw new MemberError("member_not_found", 404, "Member not found");
    }

    if (target.userId === actorUserId) {
      throw new MemberError("member_self_action", 403, "Cannot change your own membership role");
    }

    if (target.role === newRole) {
      return;
    }

    // Last-owner guard: only relevant when demoting an institution_owner.
    if (target.role === "institution_owner" && newRole !== "institution_owner") {
      const admins = await tx
        .select({ id: institutionMemberships.id })
        .from(institutionMemberships)
        .where(
          and(
            eq(institutionMemberships.institutionId, institutionId),
            eq(institutionMemberships.membershipRole, "institution_owner"),
            eq(institutionMemberships.status, "active"),
          ),
        );

      if (admins.length <= 1) {
        throw new MemberError("member_last_admin", 409, "Cannot demote the last institution admin");
      }
    }

    await tx
      .update(institutionMemberships)
      .set({ membershipRole: newRole, updatedAt: sql`now()` })
      .where(eq(institutionMemberships.id, membershipId));

    await tx.insert(institutionAuditLogs).values({
      institutionId,
      actorUserId,
      action: "member.role_changed",
      targetMembershipId: membershipId,
      metadata: { from: target.role, to: newRole },
    });
  });
};

export const removeMember = async (
  actorUserId: string,
  institutionId: string,
  membershipId: string,
  db: Database = getDb(),
): Promise<void> => {
  await requireAdminInstitutionById(actorUserId, institutionId, db);

  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: institutionMemberships.id,
        userId: institutionMemberships.userId,
        role: institutionMemberships.membershipRole,
        status: institutionMemberships.status,
      })
      .from(institutionMemberships)
      .where(
        and(
          eq(institutionMemberships.id, membershipId),
          eq(institutionMemberships.institutionId, institutionId),
          eq(institutionMemberships.status, "active"),
        ),
      )
      .limit(1);

    if (!target) {
      throw new MemberError("member_not_found", 404, "Member not found");
    }

    if (target.userId === actorUserId) {
      throw new MemberError(
        "member_self_action",
        403,
        "Cannot remove yourself from the institution",
      );
    }

    // Last-owner guard: applies whenever the target is an institution_owner.
    if (target.role === "institution_owner") {
      const admins = await tx
        .select({ id: institutionMemberships.id })
        .from(institutionMemberships)
        .where(
          and(
            eq(institutionMemberships.institutionId, institutionId),
            eq(institutionMemberships.membershipRole, "institution_owner"),
            eq(institutionMemberships.status, "active"),
          ),
        );

      if (admins.length <= 1) {
        throw new MemberError("member_last_admin", 409, "Cannot remove the last institution admin");
      }
    }

    await tx
      .update(institutionMemberships)
      .set({ status: "revoked", updatedAt: sql`now()` })
      .where(eq(institutionMemberships.id, membershipId));

    await tx.insert(institutionAuditLogs).values({
      institutionId,
      actorUserId,
      action: "member.removed",
      targetMembershipId: membershipId,
      metadata: { removedRole: target.role },
    });
  });
};
