import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-service");

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
  parseTeamCreateInput,
  parseTeamInviteCreateInput,
  parseTeamUpdateInput,
  TeamError,
  type TeamRecord,
  type TeamRosterEntry,
  type TeamWithRoster,
} from "@/server/teams/team-core";
import {
  classifyInviteIdentifier,
  resolveInviteRecipient,
} from "@/server/invitations/invite-resolution";
import { enqueueTeamInvitationDispatch } from "@/server/async/enqueue";

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
  {
    id: string;
    tokenHash: string;
    invitedEmail: string;
    status: "pending" | "pending_claim";
    expiresAt: Date;
    createdAt: Date;
  }[]
> => {
  const rows = await db
    .select({
      id: teamInvitations.id,
      tokenHash: teamInvitations.tokenHash,
      invitedEmail: teamInvitations.invitedEmail,
      status: teamInvitations.status,
      expiresAt: teamInvitations.expiresAt,
      createdAt: teamInvitations.createdAt,
    })
    .from(teamInvitations)
    // Both live states — a pending_claim seat is shown to the captain (and counts toward capacity).
    .where(
      and(
        eq(teamInvitations.teamId, teamId),
        inArray(teamInvitations.status, ["pending", "pending_claim"]),
      ),
    )
    .orderBy(teamInvitations.createdAt);

  return rows.map((row) => ({
    ...row,
    status: row.status as "pending" | "pending_claim",
  }));
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
        and(
          eq(teamInvitations.teamId, teamId),
          inArray(teamInvitations.status, ["pending", "pending_claim"]),
        ),
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
  const { invitedIdentifier } = parseTeamInviteCreateInput(payload);

  const team = await loadTeamById(teamId, db);
  if (!team) throw new TeamError("team_not_found", "Team not found");
  assertCaptain(team, userId);
  assertTeamForming(team);

  const competition = assertCompetitionTeamPlayable(
    await loadCompetitionForTeams(team.competitionId, db),
    now,
  );

  // Step 6.5e — classify (username/email) and resolve via the shared resolver (extends DEC-0082).
  const classified = classifyInviteIdentifier(invitedIdentifier);
  if (!classified) {
    throw new TeamError(
      "team_invalid_identifier",
      "invitedIdentifier must be a valid username or email address",
    );
  }

  const resolution = await resolveInviteRecipient(classified, db);
  if (resolution.mode === "username_not_found") {
    throw new TeamError("team_invite_recipient_not_found", "No account exists for that username");
  }

  const invitedEmail = resolution.invitedEmail;
  const targetUserId = resolution.mode === "targeted" ? resolution.targetUserId : null;
  const status = resolution.mode === "targeted" ? "pending" : "pending_claim";

  // Capacity counts an in-flight invite seat in EITHER live state (pending or pending_claim).
  if (competition.maxTeamSize !== null) {
    const [activeCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.status, "active")));
    const [pendingCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(teamInvitations)
      .where(
        and(
          eq(teamInvitations.teamId, teamId),
          inArray(teamInvitations.status, ["pending", "pending_claim"]),
        ),
      );

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
        inArray(teamInvitations.status, ["pending", "pending_claim"]),
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
      status,
      targetUserId,
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

  // Dual-channel send: in-app inbox entry is already live (target_user_id) for targeted invites;
  // the email is the second channel via a queued BullMQ job. Fire-and-forget — an enqueue failure
  // never blocks invite creation.
  try {
    await enqueueTeamInvitationDispatch({ invitationId: invitation.id, rawToken });
  } catch (enqueueError) {
    logger.warn("team_invitation.dispatch.enqueue_failed", {
      teamId,
      invitationId: invitation.id,
      error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
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
  // A pending OR pending_claim invite can be cancelled by the captain (the dedup + capacity guards
  // span both states, so cancel must too).
  if (invitation.status !== "pending" && invitation.status !== "pending_claim") {
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

// Captain cancels a pending invitation by tokenHash (the value stored in the DB). This is the
// token-keyed variant (G6). Step 6.5e moved recipient accept/decline in-app (session-id matched);
// this captain-side cancel is unchanged.
export const cancelTeamInvitationByToken = async (
  userId: string,
  teamId: string,
  tokenHash: string,
  db: Database = getDb(),
): Promise<void> => {
  const team = await loadTeamById(teamId, db);
  if (!team) throw new TeamError("team_not_found", "Team not found");
  assertCaptain(team, userId);
  assertTeamForming(team);

  const [invitation] = await db
    .select({ id: teamInvitations.id, status: teamInvitations.status })
    .from(teamInvitations)
    .where(
      and(eq(teamInvitations.tokenHash, tokenHash), eq(teamInvitations.teamId, teamId)),
    )
    .limit(1);

  if (!invitation) {
    throw new TeamError("team_invite_not_found", "Team invitation not found");
  }
  // A pending OR pending_claim invite can be cancelled by the captain (the dedup + capacity guards
  // span both states, so cancel must too).
  if (invitation.status !== "pending" && invitation.status !== "pending_claim") {
    throw new TeamError(
      "team_invite_not_actionable",
      `Invitation is ${invitation.status} and cannot be cancelled`,
    );
  }

  await db
    .update(teamInvitations)
    .set({ status: "cancelled" })
    .where(eq(teamInvitations.id, invitation.id));
};

// Step 6.5e — in-app, session-id-matched acceptance. The invitation is addressed by id (from the
// recipient's inbox) and accepted ONLY when session.user.id === target_user_id. A `pending_claim`
// invite has a null target and is therefore unacceptable until claim-at-signup attaches it. A
// non-leaking 404 collapses "does not exist" and "addressed to a different user". Team membership is
// candidate-scoped, so the candidate-verification gate fires here at the accept mutation.
export const acceptTeamInvitationForUser = async (
  invitationId: string,
  sessionUserId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<{ teamId: string }> => {
  return await db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(teamInvitations)
      .where(eq(teamInvitations.id, invitationId))
      .limit(1);

    if (!invitation || invitation.targetUserId !== sessionUserId) {
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

    // Candidate-verification gate (team membership is candidate-scoped). The accepting account IS
    // the resolved target; it must hold candidate verification. Non-leaking 403.
    const [sessionUser] = await tx
      .select({ id: users.id, candidateVerifiedAt: users.candidateVerifiedAt })
      .from(users)
      .where(eq(users.id, sessionUserId))
      .limit(1);

    if (!sessionUser || sessionUser.candidateVerifiedAt === null) {
      throw new TeamError(
        "team_invite_candidate_required",
        "Accepting this invitation requires a candidate-verified account",
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

// Step 6.5e — in-app decline, session-id matched. Same ownership/non-leak model as accept. Only a
// live `pending` invite addressed to the caller can be declined.
export const declineTeamInvitationForUser = async (
  invitationId: string,
  sessionUserId: string,
  db: Database = getDb(),
): Promise<void> => {
  const [invitation] = await db
    .select({
      id: teamInvitations.id,
      status: teamInvitations.status,
      targetUserId: teamInvitations.targetUserId,
    })
    .from(teamInvitations)
    .where(eq(teamInvitations.id, invitationId))
    .limit(1);

  if (!invitation || invitation.targetUserId !== sessionUserId) {
    throw new TeamError("team_invite_not_found", "Team invitation not found");
  }

  if (invitation.status !== "pending") {
    throw new TeamError(
      "team_invite_not_actionable",
      `Invitation is ${invitation.status} and cannot be declined`,
    );
  }

  await db
    .update(teamInvitations)
    .set({ status: "declined" })
    .where(eq(teamInvitations.id, invitation.id));

  logger.info("team_invitation.declined", { invitationId: invitation.id });
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

