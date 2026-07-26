import { and, eq, inArray, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionAuditLogs,
  institutionMemberships,
  institutions,
  users,
  type InstitutionMembershipRole,
} from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { MemberError, type MemberRecord } from "@/server/institution-members/member-core";

assertServerOnly("server/institution-members/member-service");

// Roles that can administer membership (list, change role, remove).
// institution_member excluded per CCR-09.
const ADMIN_ROLES = ["institution_owner", "institution_staff"] as const;

// Roles that require recruiter verification on the target account (CCR-08 / DEC-0042).
const RECRUITER_REQUIRED_ROLES: readonly InstitutionMembershipRole[] = [
  "institution_owner",
  "institution_staff",
];

// Resolves the institution by slug and verifies the calling user holds an active
// institution_owner or institution_staff membership for it. Returns the resolved
// institutionId for downstream use. 403 on slug-not-found or insufficient role
// (identical message — accepted info-hiding trade-off per 2.3-D1).
export const requireAdminInstitutionBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  db: Database,
): Promise<{ institutionId: string; actorMembershipId: string }> => {
  const [row] = await db
    .select({ institutionId: institutions.id, actorMembershipId: institutionMemberships.id })
    .from(institutions)
    .innerJoin(
      institutionMemberships,
      and(
        eq(institutionMemberships.institutionId, institutions.id),
        eq(institutionMemberships.userId, actorUserId),
        inArray(institutionMemberships.membershipRole, [...ADMIN_ROLES]),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .where(eq(institutions.slug, institutionSlug))
    .limit(1);

  if (!row) {
    throw new AccessError(
      "forbidden",
      403,
      "institution_owner or institution_staff access required",
    );
  }

  return row;
};

// Read-only sibling of requireAdminInstitutionBySlug — returns true iff the user holds
// an active membership with one of the allowed roles for the slug. Intended for
// server-component page guards that need to redirect (not throw) on missing access.
//
// Two thin wrappers cover the common cases:
//   - isInstitutionAdminBySlug:  institution_owner OR institution_staff (member admin,
//                                competition admin, invitation issuance — anywhere CCR-09
//                                excludes institution_member from an operational surface)
//   - isInstitutionOwnerBySlug:  institution_owner only (settings — per
//                                institution_workspace_shell_step_2_2.settings_authorization_rule)
const hasActiveMembershipBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  allowedRoles: readonly InstitutionMembershipRole[],
  db: Database,
): Promise<boolean> => {
  const [row] = await db
    .select({ institutionId: institutions.id })
    .from(institutions)
    .innerJoin(
      institutionMemberships,
      and(
        eq(institutionMemberships.institutionId, institutions.id),
        eq(institutionMemberships.userId, actorUserId),
        inArray(institutionMemberships.membershipRole, [...allowedRoles]),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .where(eq(institutions.slug, institutionSlug))
    .limit(1);

  return Boolean(row);
};

export const isInstitutionAdminBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  db: Database = getDb(),
): Promise<boolean> => hasActiveMembershipBySlug(actorUserId, institutionSlug, ADMIN_ROLES, db);

export const isInstitutionOwnerBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  db: Database = getDb(),
): Promise<boolean> =>
  hasActiveMembershipBySlug(actorUserId, institutionSlug, ["institution_owner"], db);

export const listActiveMembers = async (
  actorUserId: string,
  institutionSlug: string,
  db: Database = getDb(),
): Promise<MemberRecord[]> => {
  const { institutionId } = await requireAdminInstitutionBySlug(actorUserId, institutionSlug, db);

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
  institutionSlug: string,
  membershipId: string,
  newRole: InstitutionMembershipRole,
  db: Database = getDb(),
): Promise<void> => {
  const { institutionId } = await requireAdminInstitutionBySlug(actorUserId, institutionSlug, db);

  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: institutionMemberships.id,
        userId: institutionMemberships.userId,
        role: institutionMemberships.membershipRole,
        status: institutionMemberships.status,
        recruiterVerifiedAt: users.recruiterVerifiedAt,
      })
      .from(institutionMemberships)
      .innerJoin(users, eq(users.id, institutionMemberships.userId))
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

    // CCR-08: promoting to institution_owner or institution_staff requires the target
    // account to have recruiter_verified_at non-null (DEC-0042).
    if (RECRUITER_REQUIRED_ROLES.includes(newRole) && !target.recruiterVerifiedAt) {
      throw new MemberError(
        "role_escalation_forbidden",
        403,
        "Target account must have recruiter role verified to hold owner or staff membership",
      );
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
        throw new MemberError(
          "last_owner_demotion_forbidden",
          422,
          "An institution must have at least one owner",
        );
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
  institutionSlug: string,
  membershipId: string,
  db: Database = getDb(),
): Promise<void> => {
  const { institutionId } = await requireAdminInstitutionBySlug(actorUserId, institutionSlug, db);

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
