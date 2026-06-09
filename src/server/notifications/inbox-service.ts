import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/notifications/inbox-service");

import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  institutions,
  institutionInvitations,
  notifications,
  teamInvitations,
  teams,
  type InstitutionMembershipRole,
} from "@/server/db/schema";
import {
  getInstitutionDisplayName,
  institutionOwnerUsernameSql,
} from "@/server/institution-workspace/institution-display-name";

// Step 6.5.1 — unified inbox read model.
//
// The inbox combines three sources for one authenticated user: their in-app notification rows, and
// the pending non-expired invitations addressed to them. Invitations are resolved STRICTLY by
// `target_user_id` (never by `invited_email`): a row with a null target is invisible to every inbox
// query until Step 6.5e's claim-at-signup populates it. The `kind` discriminant lets the render
// layer differentiate notifications from the two invitation types. Items are merged and sorted
// newest-first by `createdAt`.

export type InboxNotificationItem = {
  kind: "notification";
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
};

export type InboxInstitutionInviteItem = {
  kind: "institution_invite";
  id: string;
  institutionName: string;
  invitedRole: InstitutionMembershipRole;
  expiresAt: Date;
  createdAt: Date;
};

export type InboxTeamInviteItem = {
  kind: "team_invite";
  id: string;
  teamName: string;
  competitionTitle: string;
  expiresAt: Date;
  createdAt: Date;
};

export type InboxItem =
  | InboxNotificationItem
  | InboxInstitutionInviteItem
  | InboxTeamInviteItem;

export const listUserInbox = async (
  userId: string,
  db: Database = getDb(),
): Promise<InboxItem[]> => {
  const now = new Date();

  const [notificationRows, institutionInviteRows, teamInviteRows] = await Promise.all([
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt)),
    db
      // Name resolved through getInstitutionDisplayName for uniformity. A personal institution can
      // never issue invitations (createInstitutionInvitation blocks it), so in practice this is
      // always a full/legacy institution and resolution returns the stored name.
      .select({
        id: institutionInvitations.id,
        institutionDisplayName: institutions.displayName,
        institutionType: institutions.institutionType,
        institutionOwnerUsername: institutionOwnerUsernameSql,
        invitedRole: institutionInvitations.invitedRole,
        expiresAt: institutionInvitations.expiresAt,
        createdAt: institutionInvitations.createdAt,
      })
      .from(institutionInvitations)
      .innerJoin(institutions, eq(institutions.id, institutionInvitations.institutionId))
      .where(
        and(
          eq(institutionInvitations.targetUserId, userId),
          eq(institutionInvitations.status, "pending"),
          gt(institutionInvitations.expiresAt, now),
        ),
      ),
    db
      .select({
        id: teamInvitations.id,
        teamName: teams.name,
        competitionTitle: competitions.title,
        expiresAt: teamInvitations.expiresAt,
        createdAt: teamInvitations.createdAt,
      })
      .from(teamInvitations)
      .innerJoin(teams, eq(teams.id, teamInvitations.teamId))
      .innerJoin(competitions, eq(competitions.id, teams.competitionId))
      .where(
        and(
          eq(teamInvitations.targetUserId, userId),
          eq(teamInvitations.status, "pending"),
          gt(teamInvitations.expiresAt, now),
        ),
      ),
  ]);

  const items: InboxItem[] = [
    ...notificationRows.map(
      (row): InboxNotificationItem => ({
        kind: "notification",
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        readAt: row.readAt,
        createdAt: row.createdAt,
      }),
    ),
    ...institutionInviteRows.map(
      (row): InboxInstitutionInviteItem => ({
        kind: "institution_invite",
        id: row.id,
        institutionName: getInstitutionDisplayName(
          { displayName: row.institutionDisplayName, institutionType: row.institutionType },
          { username: row.institutionOwnerUsername },
        ),
        invitedRole: row.invitedRole,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      }),
    ),
    ...teamInviteRows.map(
      (row): InboxTeamInviteItem => ({
        kind: "team_invite",
        id: row.id,
        teamName: row.teamName,
        competitionTitle: row.competitionTitle,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      }),
    ),
  ];

  items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return items;
};

// Unread count = unread notification rows + every pending non-expired invitation addressed to the
// user (invitations are inherently "unread/actionable" until accepted, declined, or expired).
export const countUnreadInboxItems = async (
  userId: string,
  db: Database = getDb(),
): Promise<number> => {
  const now = new Date();

  const [unreadNotificationRows, institutionInviteRows, teamInviteRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
    db
      .select({ value: count() })
      .from(institutionInvitations)
      .where(
        and(
          eq(institutionInvitations.targetUserId, userId),
          eq(institutionInvitations.status, "pending"),
          gt(institutionInvitations.expiresAt, now),
        ),
      ),
    db
      .select({ value: count() })
      .from(teamInvitations)
      .where(
        and(
          eq(teamInvitations.targetUserId, userId),
          eq(teamInvitations.status, "pending"),
          gt(teamInvitations.expiresAt, now),
        ),
      ),
  ]);

  return (
    Number(unreadNotificationRows[0]?.value ?? 0) +
    Number(institutionInviteRows[0]?.value ?? 0) +
    Number(teamInviteRows[0]?.value ?? 0)
  );
};
