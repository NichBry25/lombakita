import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-service");

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  teamInvitations,
  teamMemberships,
  teams,
  userProfiles,
  users,
} from "@/server/db/schema";
import {
  buildInvitationExpiresAt,
  generateRawToken,
  hashToken,
  maskToken,
  parseTeamCreateInput,
  parseTeamInviteCreateInput,
  parseTeamUpdateInput,
  TeamError,
  type TeamInvitationMeta,
  type TeamRecord,
  type TeamRosterEntry,
  type TeamWithRoster,
} from "@/server/teams/team-core";
import { sendTeamInvitationEmail } from "@/server/teams/team-email";

// Postgres error code extraction. drizzle-orm wraps the underlying postgres error in a
// DrizzleQueryError whose `.cause` carries the pg error fields, so reading `.code` directly off
// the thrown object yields undefined. Read both shapes — direct (from non-Drizzle paths, e.g.
// service-test mocks) and wrapped (production).
const pgErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause === "object" && typeof cause.code === "string") return cause.code;
  return undefined;
};

const TEAM_COLUMNS = {
  id: teams.id,
  competitionId: teams.competitionId,
  name: teams.name,
  captainId: teams.captainId,
  status: teams.status,
  createdAt: teams.createdAt,
  updatedAt: teams.updatedAt,
} as const;

type CompetitionTeamSnapshot = {
  id: string;
  title: string;
  status: "draft" | "published" | "archived";
  mode: "individual" | "team" | "both" | null;
  maxTeamSize: number | null;
  registrationEndAt: Date | null;
};

const loadCompetitionForTeams = async (
  competitionId: string,
  db: Database,
): Promise<CompetitionTeamSnapshot | null> => {
  const [row] = await db
    .select({
      id: competitions.id,
      title: competitions.title,
      status: competitions.status,
      mode: competitions.mode,
      maxTeamSize: competitions.maxTeamSize,
      registrationEndAt: competitions.registrationEndAt,
    })
    .from(competitions)
    .where(and(eq(competitions.id, competitionId), isNull(competitions.deletedAt)))
    .limit(1);

  return row ?? null;
};

// Assert the competition exists, is published, accepts team registration, and registration is
// still open. Returns the snapshot for downstream guards (size enforcement, etc.).
const assertCompetitionTeamPlayable = (
  competition: CompetitionTeamSnapshot | null,
  now: Date,
): CompetitionTeamSnapshot => {
  if (!competition) {
    throw new TeamError("team_competition_not_found", "Competition not found");
  }
  if (competition.status !== "published") {
    throw new TeamError(
      "team_competition_not_published",
      "Competition is not open for team registration",
    );
  }
  if (competition.mode !== "team" && competition.mode !== "both") {
    throw new TeamError(
      "team_competition_mode_not_allowed",
      "This competition does not accept team registration",
    );
  }
  if (
    !competition.registrationEndAt ||
    competition.registrationEndAt.getTime() <= now.getTime()
  ) {
    throw new TeamError(
      "team_competition_registration_closed",
      "Registration window for this competition has closed",
    );
  }
  return competition;
};

// Find any active team membership the candidate currently holds for this competition. Used by
// both create (captain auto-membership) and invite-accept (duplicate guard).
const findActiveTeamMembershipForCompetition = async (
  userId: string,
  competitionId: string,
  db: Database,
): Promise<{ teamId: string } | null> => {
  const [row] = await db
    .select({ teamId: teamMemberships.teamId })
    .from(teamMemberships)
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .where(
      and(
        eq(teamMemberships.userId, userId),
        eq(teams.competitionId, competitionId),
        eq(teamMemberships.status, "active"),
      ),
    )
    .limit(1);

  return row ?? null;
};

const loadTeamById = async (teamId: string, db: Database): Promise<TeamRecord | null> => {
  const [row] = await db.select(TEAM_COLUMNS).from(teams).where(eq(teams.id, teamId)).limit(1);
  return row ?? null;
};

const loadActiveRoster = async (teamId: string, db: Database): Promise<TeamRosterEntry[]> => {
  return db
    .select({
      membershipId: teamMemberships.id,
      userId: teamMemberships.userId,
      role: teamMemberships.role,
      status: teamMemberships.status,
      joinedAt: teamMemberships.joinedAt,
      displayName: userProfiles.displayName,
      email: users.email,
    })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, teamMemberships.userId))
    .where(
      and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")),
    )
    .orderBy(teamMemberships.joinedAt);
};

const loadPendingInvitations = async (
  teamId: string,
  db: Database,
): Promise<
  { id: string; invitedEmail: string; status: "pending"; expiresAt: Date; createdAt: Date }[]
> => {
  const rows = await db
    .select({
      id: teamInvitations.id,
      invitedEmail: teamInvitations.invitedEmail,
      status: teamInvitations.status,
      expiresAt: teamInvitations.expiresAt,
      createdAt: teamInvitations.createdAt,
    })
    .from(teamInvitations)
    .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, "pending")))
    .orderBy(teamInvitations.createdAt);

  return rows.map((row) => ({ ...row, status: "pending" as const }));
};

// Create a team for the calling candidate. Inserts the team row and the captain's
// team_memberships row in a single transaction. The captain is the first roster seat and
// counts toward maxTeamSize.
export const createTeam = async (
  userId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<TeamRecord> => {
  const { name } = parseTeamCreateInput(payload);

  const competition = assertCompetitionTeamPlayable(
    await loadCompetitionForTeams(competitionId, db),
    now,
  );

  const existing = await findActiveTeamMembershipForCompetition(userId, competitionId, db);
  if (existing) {
    throw new TeamError(
      "team_candidate_already_member",
      "You are already on a team for this competition",
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({
          competitionId: competition.id,
          name,
          captainId: userId,
          status: "forming",
        })
        .returning(TEAM_COLUMNS);

      if (!team) {
        throw new TeamError("team_invalid_payload", "Failed to create team");
      }

      await tx.insert(teamMemberships).values({
        teamId: team.id,
        userId,
        role: "captain",
        status: "active",
        joinedAt: now,
      });

      return team;
    });
  } catch (error) {
    if (error instanceof TeamError) throw error;
    if (pgErrorCode(error) === "23505") {
      // Unique-violation can come from teams_competition_id_name_unique_idx or the team
      // membership partial unique. Both are name/duplicate problems for the user.
      throw new TeamError(
        "team_name_taken",
        "A team with this name already exists for this competition",
      );
    }
    throw error;
  }
};

const assertTeamForming = (team: TeamRecord): void => {
  if (team.status !== "forming") {
    throw new TeamError("team_not_forming", "Team is no longer in forming state", {
      currentStatus: team.status,
    });
  }
};

const assertCaptain = (team: TeamRecord, userId: string): void => {
  if (team.captainId !== userId) {
    throw new TeamError("team_not_captain", "Only the team captain may perform this action");
  }
};

// Captain renames the team. Forming-only.
export const updateTeam = async (
  userId: string,
  teamId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<TeamRecord> => {
  const { name } = parseTeamUpdateInput(payload);
  const team = await loadTeamById(teamId, db);
  if (!team) throw new TeamError("team_not_found", "Team not found");

  assertCaptain(team, userId);
  assertTeamForming(team);

  try {
    // TOCTOU guard: include status='forming' so a concurrent disband between the read above and
    // this UPDATE does not silently mutate a cancelled team. Zero rowsAffected → team_not_forming.
    const [updated] = await db
      .update(teams)
      .set({ name, updatedAt: sql`now()` })
      .where(and(eq(teams.id, teamId), eq(teams.status, "forming")))
      .returning(TEAM_COLUMNS);

    if (!updated) {
      throw new TeamError("team_not_forming", "Team is no longer in forming state");
    }
    return updated;
  } catch (error) {
    if (error instanceof TeamError) throw error;
    if (pgErrorCode(error) === "23505") {
      throw new TeamError(
        "team_name_taken",
        "A team with this name already exists for this competition",
      );
    }
    throw error;
  }
};

// Captain disbands the team. Atomically: cancels every pending invitation, marks every active
// membership row as removed, and flips the team status to cancelled. The team row remains as a
// historical artefact (FK targets stay valid for any future audit).
export const disbandTeam = async (
  userId: string,
  teamId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<void> => {
  const team = await loadTeamById(teamId, db);
  if (!team) throw new TeamError("team_not_found", "Team not found");

  assertCaptain(team, userId);
  assertTeamForming(team);

  await db.transaction(async (tx) => {
    await tx
      .update(teamInvitations)
      .set({ status: "cancelled" })
      .where(
        and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, "pending")),
      );

    await tx
      .update(teamMemberships)
      .set({ status: "removed" })
      .where(
        and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")),
      );

    await tx
      .update(teams)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(teams.id, teamId));
  });

  logger.info("team.disbanded", { teamId });
};

// Get the full team + roster + pending invites snapshot. Read-side: any active member or the
// captain may call. Anyone else gets 403.
export const getTeamForViewer = async (
  userId: string,
  teamId: string,
  db: Database = getDb(),
): Promise<TeamWithRoster> => {
  const team = await loadTeamById(teamId, db);
  if (!team) throw new TeamError("team_not_found", "Team not found");

  const [membership] = await db
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.userId, userId),
        eq(teamMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (!membership && team.captainId !== userId) {
    throw new TeamError("team_forbidden", "You do not have access to this team");
  }

  const [roster, pendingInvitations] = await Promise.all([
    loadActiveRoster(teamId, db),
    loadPendingInvitations(teamId, db),
  ]);

  return { team, roster, pendingInvitations };
};

// Resolve the team that the calling candidate currently belongs to (active membership) for a
// given competition. Returns the snapshot or null if the candidate is not on any team. Used by
// the team page to bootstrap state.
export const getTeamForCompetitionAndCandidate = async (
  userId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<TeamWithRoster | null> => {
  const membership = await findActiveTeamMembershipForCompetition(userId, competitionId, db);
  if (!membership) return null;
  return getTeamForViewer(userId, membership.teamId, db);
};

// Captain invites a candidate by email. Enforces:
//   - team is forming
//   - competition is still playable for teams (window open)
//   - capacity: (active roster + pending invitations) < maxTeamSize
//   - no existing pending invitation to this email for this team
//   - no existing active membership for an account holding this email on this team
export const inviteTeamMember = async (
  userId: string,
  teamId: string,
  payload: unknown,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<{ id: string; invitedEmail: string; expiresAt: Date }> => {
  const { invitedEmail } = parseTeamInviteCreateInput(payload);

  const team = await loadTeamById(teamId, db);
  if (!team) throw new TeamError("team_not_found", "Team not found");
  assertCaptain(team, userId);
  assertTeamForming(team);

  const competition = assertCompetitionTeamPlayable(
    await loadCompetitionForTeams(team.competitionId, db),
    now,
  );

  if (competition.maxTeamSize !== null) {
    const [activeCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")));
    const [pendingCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(teamInvitations)
      .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, "pending")));

    const used = (activeCountRow?.count ?? 0) + (pendingCountRow?.count ?? 0);
    if (used >= competition.maxTeamSize) {
      throw new TeamError(
        "team_at_capacity",
        `Team has reached the maximum size of ${competition.maxTeamSize}`,
      );
    }
  }

  const [existingActiveMember] = await db
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(users.email, invitedEmail),
        eq(teamMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (existingActiveMember) {
    throw new TeamError(
      "team_candidate_already_member",
      "This person is already on the team roster",
    );
  }

  const [existingPending] = await db
    .select({ id: teamInvitations.id })
    .from(teamInvitations)
    .where(
      and(
        eq(teamInvitations.teamId, teamId),
        eq(teamInvitations.invitedEmail, invitedEmail),
        eq(teamInvitations.status, "pending"),
      ),
    )
    .limit(1);

  if (existingPending) {
    throw new TeamError(
      "team_invite_already_pending",
      "An active invitation for this email already exists for this team",
    );
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = buildInvitationExpiresAt(now);

  const [invitation] = await db
    .insert(teamInvitations)
    .values({
      teamId,
      invitedEmail,
      invitedByUserId: userId,
      tokenHash,
      status: "pending",
      expiresAt,
    })
    .returning({
      id: teamInvitations.id,
      invitedEmail: teamInvitations.invitedEmail,
      expiresAt: teamInvitations.expiresAt,
    });

  if (!invitation) {
    throw new TeamError("team_invalid_payload", "Failed to create team invitation");
  }

  // Dispatch the email post-commit. Failure is logged but does not fail the API call — the
  // token is still valid and can be retrieved by other means (operator support, log of token
  // prefix).
  try {
    const [inviter] = await db
      .select({ displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);

    await sendTeamInvitationEmail({
      toEmail: invitedEmail,
      teamName: team.name,
      competitionTitle: competition.title,
      inviterDisplayName: inviter?.displayName ?? null,
      rawToken,
      expiresAt,
    });
  } catch (emailError) {
    logger.error("team_invitation.email_failed", {
      teamId,
      tokenPrefix: maskToken(rawToken),
      error: emailError instanceof Error ? emailError.message : String(emailError),
    });
  }

  return invitation;
};

// Captain cancels a pending invitation.
export const cancelTeamInvitation = async (
  userId: string,
  teamId: string,
  invitationId: string,
  db: Database = getDb(),
): Promise<void> => {
  const team = await loadTeamById(teamId, db);
  if (!team) throw new TeamError("team_not_found", "Team not found");
  assertCaptain(team, userId);
  assertTeamForming(team);

  const [invitation] = await db
    .select({ id: teamInvitations.id, status: teamInvitations.status })
    .from(teamInvitations)
    .where(and(eq(teamInvitations.id, invitationId), eq(teamInvitations.teamId, teamId)))
    .limit(1);

  if (!invitation) {
    throw new TeamError("team_invite_not_found", "Team invitation not found");
  }
  if (invitation.status !== "pending") {
    throw new TeamError(
      "team_invite_not_actionable",
      `Invitation is ${invitation.status} and cannot be cancelled`,
    );
  }

  await db
    .update(teamInvitations)
    .set({ status: "cancelled" })
    .where(eq(teamInvitations.id, invitationId));
};

// Unauthenticated metadata read. Returns team name, competition title, inviter display name
// (best-effort), and the invite status/expiry. Does NOT expose the roster.
export const getTeamInvitationMetaByToken = async (
  rawToken: string,
  db: Database = getDb(),
): Promise<TeamInvitationMeta> => {
  const tokenHash = hashToken(rawToken);

  const [row] = await db
    .select({
      id: teamInvitations.id,
      teamId: teamInvitations.teamId,
      teamName: teams.name,
      competitionId: teams.competitionId,
      competitionTitle: competitions.title,
      invitedEmail: teamInvitations.invitedEmail,
      inviterDisplayName: userProfiles.displayName,
      status: teamInvitations.status,
      expiresAt: teamInvitations.expiresAt,
      createdAt: teamInvitations.createdAt,
    })
    .from(teamInvitations)
    .innerJoin(teams, eq(teams.id, teamInvitations.teamId))
    .innerJoin(competitions, eq(competitions.id, teams.competitionId))
    .leftJoin(userProfiles, eq(userProfiles.userId, teamInvitations.invitedByUserId))
    .where(eq(teamInvitations.tokenHash, tokenHash))
    .limit(1);

  if (!row) throw new TeamError("team_invite_not_found", "Team invitation not found");
  return row;
};

// Authenticated candidate accepts the invitation. All six steps in one transaction:
//   (a) lookup by hash
//   (b) status=pending + not expired
//   (c) resolve invited_email to a user row → 404 if no candidate account exists
//   (d) email of resolved user must equal session user's email (the route layer passes the
//       session user id; we re-load to compare emails inside the transaction)
//   (e) no existing active team membership for this competition for this user
//   (f) insert team_memberships row + update invitation row
export const acceptTeamInvitation = async (
  rawToken: string,
  sessionUserId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<{ teamId: string }> => {
  const tokenHash = hashToken(rawToken);

  return await db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(teamInvitations)
      .where(eq(teamInvitations.tokenHash, tokenHash))
      .limit(1);

    if (!invitation) {
      throw new TeamError("team_invite_not_found", "Team invitation not found");
    }

    if (invitation.status !== "pending") {
      throw new TeamError(
        "team_invite_not_actionable",
        `Invitation is ${invitation.status} and cannot be accepted`,
      );
    }

    if (invitation.expiresAt < now) {
      await tx
        .update(teamInvitations)
        .set({ status: "cancelled" })
        .where(eq(teamInvitations.id, invitation.id));
      throw new TeamError("team_invite_not_actionable", "Invitation has expired");
    }

    const [team] = await tx
      .select({
        id: teams.id,
        competitionId: teams.competitionId,
        status: teams.status,
      })
      .from(teams)
      .where(eq(teams.id, invitation.teamId))
      .limit(1);

    if (!team) {
      throw new TeamError("team_not_found", "Team no longer exists");
    }

    if (team.status !== "forming") {
      throw new TeamError("team_not_forming", "Team is no longer accepting members");
    }

    // Step (c) per contract: resolve invited_email to a *candidate* user row. A recruiter-only
    // account with no candidateVerifiedAt is treated as non-existent here — same external error
    // code as the no-account branch so the two cases are indistinguishable to the caller.
    const [resolvedByEmail] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.email, invitation.invitedEmail), isNotNull(users.candidateVerifiedAt)))
      .limit(1);

    if (!resolvedByEmail) {
      throw new TeamError(
        "team_invite_account_not_found",
        "No candidate account exists for the invited email",
      );
    }

    const [sessionUser] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, sessionUserId))
      .limit(1);

    // Normalize both sides before comparison. invitation.invitedEmail is lowercased at parse;
    // users.email is lowercased at signup, but normalizing here keeps the assertion robust if any
    // future write path stores a mixed-case email.
    if (
      !sessionUser ||
      sessionUser.email.toLowerCase() !== invitation.invitedEmail.toLowerCase()
    ) {
      throw new TeamError(
        "team_invite_email_mismatch",
        "This invitation was sent to a different email address",
      );
    }

    const [existingForCompetition] = await tx
      .select({ teamId: teamMemberships.teamId })
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(
        and(
          eq(teamMemberships.userId, sessionUserId),
          eq(teams.competitionId, team.competitionId),
          eq(teamMemberships.status, "active"),
        ),
      )
      .limit(1);

    if (existingForCompetition) {
      throw new TeamError(
        "team_candidate_already_member",
        "You are already on a team for this competition",
      );
    }

    try {
      await tx.insert(teamMemberships).values({
        teamId: team.id,
        userId: sessionUserId,
        role: "member",
        status: "active",
        joinedAt: now,
      });
    } catch (error) {
      if (pgErrorCode(error) === "23505") {
        throw new TeamError(
          "team_candidate_already_member",
          "You are already on this team",
        );
      }
      throw error;
    }

    await tx
      .update(teamInvitations)
      .set({ status: "accepted", acceptedAt: now })
      .where(eq(teamInvitations.id, invitation.id));

    logger.info("team_invitation.accepted", { teamId: team.id });

    return { teamId: team.id };
  });
};

// Unauthenticated decline. Sets the invitation to declined; returns nothing observable beyond
// success/failure. Does not reveal team or roster data.
export const declineTeamInvitation = async (
  rawToken: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<void> => {
  const tokenHash = hashToken(rawToken);

  const [invitation] = await db
    .select({
      id: teamInvitations.id,
      status: teamInvitations.status,
      expiresAt: teamInvitations.expiresAt,
    })
    .from(teamInvitations)
    .where(eq(teamInvitations.tokenHash, tokenHash))
    .limit(1);

  if (!invitation) {
    throw new TeamError("team_invite_not_found", "Team invitation not found");
  }

  if (invitation.status !== "pending") {
    throw new TeamError(
      "team_invite_not_actionable",
      `Invitation is ${invitation.status} and cannot be declined`,
    );
  }

  if (invitation.expiresAt < now) {
    await db
      .update(teamInvitations)
      .set({ status: "cancelled" })
      .where(eq(teamInvitations.id, invitation.id));
    throw new TeamError("team_invite_not_actionable", "Invitation has expired");
  }

  await db
    .update(teamInvitations)
    .set({ status: "declined" })
    .where(eq(teamInvitations.id, invitation.id));

  logger.info("team_invitation.declined", { tokenPrefix: maskToken(rawToken) });
};

// Remove a member from the team. The caller is either:
//   - the captain (removing another member; cannot remove themselves — must disband)
//   - the member themselves (leaving voluntarily)
// In either case the team must be forming. Captain cannot leave: returns team_captain_cannot_leave.
export const removeTeamMember = async (
  callerUserId: string,
  teamId: string,
  membershipId: string,
  db: Database = getDb(),
): Promise<void> => {
  const team = await loadTeamById(teamId, db);
  if (!team) throw new TeamError("team_not_found", "Team not found");
  assertTeamForming(team);

  const [membership] = await db
    .select({
      id: teamMemberships.id,
      teamId: teamMemberships.teamId,
      userId: teamMemberships.userId,
      role: teamMemberships.role,
      status: teamMemberships.status,
    })
    .from(teamMemberships)
    .where(eq(teamMemberships.id, membershipId))
    .limit(1);

  if (!membership || membership.teamId !== teamId) {
    throw new TeamError("team_membership_not_found", "Team membership not found");
  }

  if (membership.status !== "active") {
    throw new TeamError("team_member_not_in_team", "Member is no longer on this team");
  }

  if (membership.role === "captain") {
    // Captain cannot leave — must disband. Distinct error code so the UI can route the user.
    throw new TeamError(
      "team_captain_cannot_leave",
      "Captain cannot leave the team; disband the team instead",
    );
  }

  const isSelfRemove = membership.userId === callerUserId;
  const isCaptainRemove = team.captainId === callerUserId;
  if (!isSelfRemove && !isCaptainRemove) {
    throw new TeamError(
      "team_forbidden",
      "Only the captain or the member themselves may remove a member",
    );
  }

  await db
    .update(teamMemberships)
    .set({ status: "removed" })
    .where(eq(teamMemberships.id, membershipId));

  logger.info("team_membership.removed", {
    teamId,
    membershipId,
    byCaptain: isCaptainRemove && !isSelfRemove,
  });
};

