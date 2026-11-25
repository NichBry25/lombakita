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
import { COMPETITIONS_CHANGING_RETRY_MESSAGE } from "@/lib/errors/error-copy";
import { MEMBER_ROLES } from "@/server/competitions/competition-access";
import { isHostTrustRemoved } from "@/server/host-trust/publish-trust";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { MemberError, type MemberRecord } from "@/server/institution-members/member-core";
import {
  holdsLivePlaceInInstitution,
  lockInstitutionCompetitionsForPlaceCheck,
} from "@/server/institution-members/live-place";
import { countActiveOwners } from "@/server/institution-members/owner-count";
import { lockInstitutionOwnership } from "@/server/institution-members/owner-membership-lock";

assertServerOnly("server/institution-members/member-service");

// Roles that can administer membership (list, change role, remove).
// institution_member is excluded — no operational surface.
const ADMIN_ROLES = ["institution_owner", "institution_staff"] as const;

/**
 * Everyone who administers this institution, the exact set the review gate admits.
 *
 * Built on ADMIN_ROLES rather than on its own list so the people NOTIFIED about a bukti transfer
 * and the people PERMITTED to rule on it cannot drift apart. Notifying someone who cannot act, or
 * failing to notify someone who can, are the two failures a second role list produces.
 */
export const listInstitutionAdminUserIds = async (
  institutionId: string,
  db: Database = getDb(),
): Promise<string[]> => {
  const rows = await db
    .select({ userId: institutionMemberships.userId })
    .from(institutionMemberships)
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.status, "active"),
        inArray(institutionMemberships.membershipRole, [...ADMIN_ROLES]),
      ),
    );

  return rows.map((row) => row.userId);
};

// Roles that require recruiter verification on the target account (DEC-0042).
const RECRUITER_REQUIRED_ROLES: readonly InstitutionMembershipRole[] = [
  "institution_owner",
  "institution_staff",
];

// Resolves the institution by slug and verifies the calling user holds an active
// institution_owner or institution_staff membership for it. Returns the resolved
// institutionId for downstream use. 403 on slug-not-found or insufficient role
// (identical message — accepted info-hiding trade-off per 2.3-D1).
const requireMembershipBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  allowedRoles: readonly InstitutionMembershipRole[],
  requiredMessage: string,
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
        inArray(institutionMemberships.membershipRole, [...allowedRoles]),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .where(eq(institutions.slug, institutionSlug))
    .limit(1);

  if (!row) {
    throw new AccessError("forbidden", 403, requiredMessage);
  }

  return row;
};

export const requireAdminInstitutionBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  db: Database,
): Promise<{ institutionId: string; actorMembershipId: string }> =>
  requireMembershipBySlug(
    actorUserId,
    institutionSlug,
    ADMIN_ROLES,
    "institution_owner or institution_staff access required",
    db,
  );

/**
 * Owner-only sibling, for surfaces where staff access would be a separation-of-duties failure.
 *
 * Payment instructions are the one. Staff already decide whether a transfer ARRIVED; letting them
 * also decide WHERE transfers are sent would put both halves of "redirect the money and mark it
 * received" in one pair of hands. The owner is the account holder, so the owner sets the account.
 */
export const requireOwnerInstitutionBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  db: Database,
): Promise<{ institutionId: string; actorMembershipId: string }> =>
  requireMembershipBySlug(
    actorUserId,
    institutionSlug,
    ["institution_owner"],
    "institution_owner access required",
    db,
  );

// Read-only sibling of requireAdminInstitutionBySlug — returns true iff the user holds
// an active membership with one of the allowed roles for the slug. Intended for
// server-component page guards that need to redirect (not throw) on missing access.
//
// Two thin wrappers cover the common cases:
//   - isInstitutionAdminBySlug:  institution_owner OR institution_staff (member admin,
//                                competition admin, invitation issuance — anywhere
//                                institution_member is excluded from an operational surface)
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

// Every role that puts a person inside the institution, institution_member included. The question
// this answers is "is the caller on the inside", not "may the caller operate anything" — which is
// why it is not built on ADMIN_ROLES: a plain member is an insider for the purpose that consumes it
// (an unverified institution's contact details are shown to its own people, DEC-0158's exposure
// rule) while holding no operational permission at all.
const ALL_MEMBERSHIP_ROLES: readonly InstitutionMembershipRole[] = [
  "institution_owner",
  "institution_staff",
  "institution_member",
];

export const isInstitutionMemberBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  db: Database = getDb(),
): Promise<boolean> =>
  hasActiveMembershipBySlug(actorUserId, institutionSlug, ALL_MEMBERSHIP_ROLES, db);

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

type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

// DEC-0273 keeps a host from joining; this keeps a joined person from becoming a host.
const lockCompetitionsAndRefuseTargetHoldingLivePlace = async (
  tx: TransactionClient,
  institutionId: string,
  targetUserId: string,
): Promise<void> => {
  await lockInstitutionCompetitionsForPlaceCheck(
    tx,
    institutionId,
    () => new MemberError("member_role_retry", 409, COMPETITIONS_CHANGING_RETRY_MESSAGE),
  );

  if (await holdsLivePlaceInInstitution(tx, targetUserId, institutionId)) {
    throw new MemberError(
      "member_holds_competition_place",
      409,
      "Member holds a place in a running competition of this institution and cannot become its owner or staff",
    );
  }
};

// A person whose host trust staff removed does not give the owner or staff role to anyone, which
// would let an account they may control act on the workspace free of the holds. The check reads the
// new role only, so it also refuses them moving an owner to staff. Moving anyone to member stays open.
// Other owners and staff are not bound.
// Throws MemberError 403 member_role_blocked_trust_removed.
const assertRoleGrantNotByRemovedHost = async (
  actorUserId: string,
  newRole: InstitutionMembershipRole,
  db: Database,
): Promise<void> => {
  if (newRole === "institution_member") return;
  const trustRemoved = await isHostTrustRemoved(actorUserId, db);
  if (!trustRemoved) return;
  throw new MemberError(
    "member_role_blocked_trust_removed",
    403,
    "A host whose trust staff removed cannot give the owner or staff role",
  );
};

export const changeMemberRole = async (
  actorUserId: string,
  institutionSlug: string,
  membershipId: string,
  newRole: InstitutionMembershipRole,
  db: Database = getDb(),
): Promise<void> => {
  const { institutionId } = await requireAdminInstitutionBySlug(actorUserId, institutionSlug, db);
  await assertRoleGrantNotByRemovedHost(actorUserId, newRole, db);

  await db.transaction(async (tx) => {
    // Taken before the target read so the whole transaction, including the owner count below, sees
    // one consistent set of memberships: a demotion and a concurrent de-identification of a
    // co-owner each count the other's row, and counting a row the other transaction is about to
    // change is how an institution ends up with no owner at all.
    await lockInstitutionOwnership(tx, [institutionId]);

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

    // Promoting to institution_owner or institution_staff requires the target
    // account to have recruiter_verified_at non-null (DEC-0042).
    if (RECRUITER_REQUIRED_ROLES.includes(newRole) && !target.recruiterVerifiedAt) {
      throw new MemberError(
        "role_escalation_forbidden",
        403,
        "Target account must have recruiter role verified to hold owner or staff membership",
      );
    }

    // Taken after every refusal above and after lockInstitutionOwnership, never the reverse. Moves
    // between owner and staff, and demotions, wait behind no competition lock.
    if (target.role === "institution_member" && MEMBER_ROLES.includes(newRole)) {
      await lockCompetitionsAndRefuseTargetHoldingLivePlace(tx, institutionId, target.userId);
    }

    // Last-owner guard: only relevant when demoting an institution_owner.
    if (target.role === "institution_owner" && newRole !== "institution_owner") {
      const owners = await countActiveOwners(tx, institutionId);

      if (owners <= 1) {
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
    // Same lock as changeMemberRole's, and for the same reason: the count below decides whether the
    // removal is allowed, and it must not run against memberships a concurrent de-identification is
    // in the middle of revoking.
    await lockInstitutionOwnership(tx, [institutionId]);

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
      const owners = await countActiveOwners(tx, institutionId);

      if (owners <= 1) {
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
