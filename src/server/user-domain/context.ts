import { and, eq } from "drizzle-orm";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { getDb } from "@/server/db/client";
import {
  institutions,
  institutionMemberships,
  platformUserRoleEnum,
  userPlatformRoles,
  userProfiles,
  users,
  type AppUserStatus,
  type InstitutionMembershipRole,
  type InstitutionMembershipStatus,
  type InstitutionStatus,
  type PlatformUserRole,
} from "@/server/db/schema";
import { getInstitutionDisplayName } from "@/server/institution-workspace/institution-display-name";

assertServerOnly("server/user-domain/context");

export type InstitutionMembershipRecord = {
  membershipId: string;
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  institutionStatus: InstitutionStatus;
  membershipRole: InstitutionMembershipRole;
  membershipStatus: InstitutionMembershipStatus;
  joinedAt: Date;
};

export type UserDomainContext = {
  userId: string;
  email: string;
  accountStatus: AppUserStatus;
  primaryRole: (typeof users.$inferSelect)["role"];
  platformRoles: PlatformUserRole[];
  profile: {
    displayName: string | null;
    phoneNumber: string | null;
    avatarUrl: string | null;
    summary: string | null;
  };
  memberships: InstitutionMembershipRecord[];
};

const listMembershipsForUser = async (
  userId: string,
  options?: { activeOnly?: boolean },
): Promise<InstitutionMembershipRecord[]> => {
  const db = getDb();

  const whereClause = options?.activeOnly
    ? and(eq(institutionMemberships.userId, userId), eq(institutionMemberships.status, "active"))
    : eq(institutionMemberships.userId, userId);

  const rows = await db
    .select({
      membershipId: institutionMemberships.id,
      institutionId: institutionMemberships.institutionId,
      institutionSlug: institutions.slug,
      institutionDisplayName: institutions.displayName,
      institutionType: institutions.institutionType,
      institutionStatus: institutions.status,
      membershipRole: institutionMemberships.membershipRole,
      membershipStatus: institutionMemberships.status,
      joinedAt: institutionMemberships.joinedAt,
      // The membership's own user — for a personal institution this is the owner, whose username
      // resolves the derived display name. Full institutions ignore this (stored name authoritative).
      memberUsername: users.username,
    })
    .from(institutionMemberships)
    .innerJoin(institutions, eq(institutions.id, institutionMemberships.institutionId))
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(whereClause);

  return rows.map(({ institutionType, memberUsername, ...rest }) => ({
    ...rest,
    institutionDisplayName: getInstitutionDisplayName(
      { displayName: rest.institutionDisplayName, institutionType },
      { username: memberUsername },
    ),
  }));
};

export const getInstitutionMembershipForUser = async (
  userId: string,
  institutionId: string,
  options?: { activeOnly?: boolean },
): Promise<InstitutionMembershipRecord | null> => {
  const memberships = await listMembershipsForUser(userId, {
    activeOnly: options?.activeOnly,
  });

  return memberships.find((membership) => membership.institutionId === institutionId) ?? null;
};

export const getUserDomainContext = async (userId: string): Promise<UserDomainContext | null> => {
  const db = getDb();

  const [userRow] = await db
    .select({
      userId: users.id,
      email: users.email,
      accountStatus: users.status,
      primaryRole: users.role,
      profileDisplayName: userProfiles.displayName,
      profilePhoneNumber: userProfiles.phoneNumber,
      profileAvatarUrl: userProfiles.avatarUrl,
      profileSummary: userProfiles.summary,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!userRow) {
    return null;
  }

  const roleRows = await db
    .select({ role: userPlatformRoles.role })
    .from(userPlatformRoles)
    .where(eq(userPlatformRoles.userId, userId));

  const roleSet = new Set<PlatformUserRole>();

  if (platformUserRoleEnum.enumValues.includes(userRow.primaryRole as PlatformUserRole)) {
    roleSet.add(userRow.primaryRole as PlatformUserRole);
  }

  for (const row of roleRows) {
    roleSet.add(row.role);
  }

  const memberships = await listMembershipsForUser(userId);

  return {
    userId: userRow.userId,
    email: userRow.email,
    accountStatus: userRow.accountStatus,
    primaryRole: userRow.primaryRole,
    platformRoles: Array.from(roleSet),
    profile: {
      displayName: userRow.profileDisplayName,
      phoneNumber: userRow.profilePhoneNumber,
      avatarUrl: userRow.profileAvatarUrl,
      summary: userRow.profileSummary,
    },
    memberships,
  };
};
