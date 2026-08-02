import { and, eq, inArray } from "drizzle-orm";
import type { AppRole } from "@/lib/access/roles";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionInvitations,
  institutionMemberships,
  institutions,
  users,
  type InstitutionType,
} from "@/server/db/schema";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";
import { logger } from "@/lib/logger";
import {
  buildInvitationExpiresAt,
  generateRawToken,
  hashToken,
  InstitutionInvitationError,
  parseInvitationCreateInput,
  RECRUITER_VERIFIED_ROLES,
  type InvitationCreateInput,
} from "@/server/institution-invitations/invitation-core";
import {
  classifyInviteIdentifier,
  resolveInviteRecipient,
} from "@/server/invitations/invite-resolution";
import { enqueueInstitutionInvitationDispatch } from "@/server/async/enqueue";
import { markRecruiterSubmissionVouched } from "@/server/recruiter-verification/recruiter-verification-service";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-invitations/invitation-service");

const ADMIN_ROLES = ["institution_owner", "institution_staff"] as const;

// Vouch signal: true when the institution has at least one active institution_owner whose
// recruiter account is Trusted (tier `elevated`). A Trusted owner vouching for a new owner/staff
// member is the strongest queue-priority signal — but only a priority bump, never an auto-grant.
const institutionHasTrustedOwner = async (
  institutionId: string,
  db: Database,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: institutionMemberships.id })
    .from(institutionMemberships)
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.membershipRole, "institution_owner"),
        eq(institutionMemberships.status, "active"),
        eq(users.recruiterVerificationTier, "elevated"),
      ),
    )
    .limit(1);

  return row !== undefined;
};

const requireAdminInstitution = async (
  userId: string,
  institutionSlug: string,
  db: Database,
): Promise<{
  institutionId: string;
  institutionType: InstitutionType | null;
}> => {
  const [row] = await db
    .select({
      institutionId: institutions.id,
      institutionType: institutions.institutionType,
    })
    .from(institutions)
    .innerJoin(
      institutionMemberships,
      and(
        eq(institutionMemberships.institutionId, institutions.id),
        eq(institutionMemberships.userId, userId),
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
      "institution_owner or institution_staff access required for this institution",
    );
  }

  return row;
};

export const createInstitutionInvitation = async (
  userId: string,
  institutionSlug: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<{ id: string; invitedEmail: string; expiresAt: Date }> => {
  const input: InvitationCreateInput = parseInvitationCreateInput(payload);
  const { institutionId, institutionType } = await requireAdminInstitution(
    userId,
    institutionSlug,
    db,
  );

  // A personal institution is single-member: it cannot invite staff or members.
  // No-op for full or legacy institutions (NULL type).
  if (isPersonalInstitutionType(institutionType)) {
    throw new InstitutionInvitationError(
      "invitation_personal_institution",
      403,
      "A personal institution cannot invite staff or members",
    );
  }

  // Classify the identifier (username or email) and resolve the recipient. This is the
  // shared resolver (extends DEC-0082); the service never builds its own.
  const classified = classifyInviteIdentifier(input.invitedIdentifier);
  if (!classified) {
    throw new InstitutionInvitationError(
      "invitation_invalid_identifier",
      400,
      "invitedIdentifier must be a valid username or email address",
    );
  }

  const resolution = await resolveInviteRecipient(classified, db);
  if (resolution.mode === "username_not_found") {
    throw new InstitutionInvitationError(
      "invitation_recipient_not_found",
      404,
      "No account exists for that username",
    );
  }

  // After resolution we always have a canonical lowercased email to dedup and store against.
  const invitedEmail = resolution.invitedEmail;
  const targetUserId = resolution.mode === "targeted" ? resolution.targetUserId : null;
  // `pending` once an account exists (inbox-visible); `pending_claim` for a not-yet-registered
  // email (inbox-invisible until claim-at-signup attaches it).
  const status = resolution.mode === "targeted" ? "pending" : "pending_claim";

  const [existingMember] = await db
    .select({ membershipId: institutionMemberships.id })
    .from(institutionMemberships)
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(users.email, invitedEmail),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (existingMember) {
    throw new InstitutionInvitationError(
      "invitation_already_member",
      409,
      "This person is already a member of this institution",
    );
  }

  // Dedup guard spans BOTH live states: an existing pending OR pending_claim invite to the same
  // email for this institution blocks a duplicate.
  const [existingPending] = await db
    .select({ id: institutionInvitations.id })
    .from(institutionInvitations)
    .where(
      and(
        eq(institutionInvitations.institutionId, institutionId),
        eq(institutionInvitations.invitedEmail, invitedEmail),
        inArray(institutionInvitations.status, ["pending", "pending_claim"]),
      ),
    )
    .limit(1);

  if (existingPending) {
    throw new InstitutionInvitationError(
      "invitation_already_pending",
      409,
      "An active invitation for this email already exists for this institution",
    );
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = buildInvitationExpiresAt();

  const [invitation] = await db
    .insert(institutionInvitations)
    .values({
      institutionId,
      invitedEmail,
      invitedRole: input.invitedRole,
      tokenHash,
      status,
      invitedByUserId: userId,
      targetUserId,
      expiresAt,
    })
    .returning({
      id: institutionInvitations.id,
      invitedEmail: institutionInvitations.invitedEmail,
      expiresAt: institutionInvitations.expiresAt,
    });

  if (!invitation) {
    throw new Error("Failed to create invitation record");
  }

  // Dual-channel send: the in-app inbox entry is already live for `targeted` invites (target_user_id
  // set); the email is the second channel via a queued BullMQ job. Fire-and-forget — an enqueue
  // failure NEVER blocks invite creation.
  try {
    await enqueueInstitutionInvitationDispatch({ invitationId: invitation.id, rawToken });
  } catch (enqueueError) {
    logger.warn("invitation.dispatch.enqueue_failed", {
      invitationId: invitation.id,
      error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
    });
  }

  return invitation;
};

// In-app, session-id-matched acceptance. Acceptance is no longer token-in-URL: the
// invitation is addressed by id (from the recipient's inbox) and accepted ONLY when
// session.user.id === target_user_id. A `pending_claim` invite has a null target and is therefore
// unacceptable by anyone until claim-at-signup attaches it. A non-leaking 404 collapses
// "invitation does not exist" and "addressed to a different user" so a caller cannot probe.
//
// The verification gate (DEC-0042) fires HERE, at the accept mutation, not at display.
export const acceptInstitutionInvitationForUser = async (
  invitationId: string,
  userId: string,
  sessionVerifiedRoles: AppRole[],
  db: Database = getDb(),
): Promise<void> => {
  await db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(institutionInvitations)
      .where(eq(institutionInvitations.id, invitationId))
      .limit(1);

    // Existence + ownership collapse to one non-leaking 404 (mirrors the inbox notification guard).
    if (!invitation || invitation.targetUserId !== userId) {
      throw new InstitutionInvitationError("invitation_not_found", 404, "Invitation not found");
    }

    if (invitation.status !== "pending") {
      throw new InstitutionInvitationError(
        "invitation_not_actionable",
        410,
        `Invitation is ${invitation.status} and cannot be accepted`,
      );
    }

    const now = new Date();
    if (invitation.expiresAt < now) {
      await tx
        .update(institutionInvitations)
        .set({ status: "expired" })
        .where(eq(institutionInvitations.id, invitation.id));
      throw new InstitutionInvitationError(
        "invitation_not_actionable",
        410,
        "Invitation has expired",
      );
    }

    // institution_owner and institution_staff invites require the
    // accepting account to hold "recruiter" in its verified roles; institution_member invites accept
    // any authenticated account. Enforced server-side at the accept moment — the inbox may render
    // the card, but the server is the gate.
    if (RECRUITER_VERIFIED_ROLES.includes(invitation.invitedRole)) {
      if (!sessionVerifiedRoles.includes("recruiter")) {
        throw new InstitutionInvitationError(
          "invitation_role_verification_required",
          403,
          "Accepting this invitation requires a recruiter-verified account",
          "/verify/recruiter",
        );
      }
    }

    // Removal is soft: removeMember sets status='revoked' and keeps the row so the audit trail
    // still resolves. A unique index on (institution_id, user_id) means a rejoin cannot insert a
    // second row, so this branches on the CURRENT status rather than on the row's existence —
    // reading existence alone refused every rejoin with "You are already a member", which was both
    // a refusal and a false statement, while the invite-creation guard (which does filter on
    // 'active') happily issued the invitation that could never be accepted.
    const [existingMembership] = await tx
      .select({ id: institutionMemberships.id, status: institutionMemberships.status })
      .from(institutionMemberships)
      .where(
        and(
          eq(institutionMemberships.userId, userId),
          eq(institutionMemberships.institutionId, invitation.institutionId),
        ),
      )
      .limit(1);

    if (existingMembership?.status === "active") {
      throw new InstitutionInvitationError(
        "invitation_already_member",
        409,
        "You are already a member of this institution",
      );
    }

    if (existingMembership) {
      // The role comes from the NEW invitation, not the retained row: someone removed as staff and
      // re-invited as a member must come back as a member. joinedAt restarts because this is a new
      // period of membership; the original dates survive in the institution audit log.
      await tx
        .update(institutionMemberships)
        .set({
          membershipRole: invitation.invitedRole,
          status: "active",
          invitedByUserId: invitation.invitedByUserId,
          joinedAt: now,
          updatedAt: now,
        })
        .where(eq(institutionMemberships.id, existingMembership.id));
    } else {
      await tx.insert(institutionMemberships).values({
        institutionId: invitation.institutionId,
        userId,
        membershipRole: invitation.invitedRole,
        status: "active",
        invitedByUserId: invitation.invitedByUserId,
      });
    }

    await tx
      .update(institutionInvitations)
      .set({ status: "accepted", acceptedAt: now })
      .where(eq(institutionInvitations.id, invitation.id));

    // Vouch bump: accepting an owner/staff invite from an institution that already has a Trusted
    // owner moves any open recruiter trust submission to the top of the review queue. Priority
    // only — the platform-ops background check is still the gate. No-op when the accepter has no
    // open submission (e.g. already Trusted) or the institution has no Trusted owner.
    if (RECRUITER_VERIFIED_ROLES.includes(invitation.invitedRole)) {
      const vouched = await institutionHasTrustedOwner(invitation.institutionId, tx);
      if (vouched) {
        await markRecruiterSubmissionVouched(userId, tx);
      }
    }

    logger.info("invitation.accepted", {
      institutionId: invitation.institutionId,
      invitedRole: invitation.invitedRole,
    });
  });
};

// In-app decline, session-id matched. Same ownership/non-leak model as accept. Only a
// live `pending` invite addressed to the caller can be declined.
export const declineInstitutionInvitationForUser = async (
  invitationId: string,
  userId: string,
  db: Database = getDb(),
): Promise<void> => {
  const [invitation] = await db
    .select({
      id: institutionInvitations.id,
      status: institutionInvitations.status,
      targetUserId: institutionInvitations.targetUserId,
    })
    .from(institutionInvitations)
    .where(eq(institutionInvitations.id, invitationId))
    .limit(1);

  if (!invitation || invitation.targetUserId !== userId) {
    throw new InstitutionInvitationError("invitation_not_found", 404, "Invitation not found");
  }

  if (invitation.status !== "pending") {
    throw new InstitutionInvitationError(
      "invitation_not_actionable",
      410,
      `Invitation is ${invitation.status} and cannot be declined`,
    );
  }

  await db
    .update(institutionInvitations)
    .set({ status: "declined" })
    .where(eq(institutionInvitations.id, invitation.id));

  logger.info("invitation.declined", { invitationId: invitation.id });
};

export const cancelInvitation = async (
  userId: string,
  institutionSlug: string,
  invitationId: string,
  db: Database = getDb(),
): Promise<void> => {
  const { institutionId } = await requireAdminInstitution(userId, institutionSlug, db);

  const [invitation] = await db
    .select({ id: institutionInvitations.id, status: institutionInvitations.status })
    .from(institutionInvitations)
    .where(
      and(
        eq(institutionInvitations.id, invitationId),
        eq(institutionInvitations.institutionId, institutionId),
      ),
    )
    .limit(1);

  if (!invitation) {
    throw new InstitutionInvitationError("invitation_not_found", 404, "Invitation not found");
  }

  // A pending OR pending_claim invite can be cancelled by the issuing admin (the dedup guard spans
  // both states, so cancel must too — otherwise a pending_claim blocks re-invite until expiry).
  if (invitation.status !== "pending" && invitation.status !== "pending_claim") {
    throw new InstitutionInvitationError(
      "invitation_not_actionable",
      410,
      `Invitation is ${invitation.status} and cannot be cancelled`,
    );
  }

  await db
    .update(institutionInvitations)
    .set({ status: "cancelled" })
    .where(eq(institutionInvitations.id, invitation.id));
};

export const listPendingInvitations = async (
  userId: string,
  institutionSlug: string,
  db: Database = getDb(),
): Promise<
  {
    id: string;
    invitedEmail: string;
    invitedRole: string;
    status: string;
    expiresAt: Date;
    createdAt: Date;
  }[]
> => {
  const { institutionId } = await requireAdminInstitution(userId, institutionSlug, db);

  return db
    .select({
      id: institutionInvitations.id,
      invitedEmail: institutionInvitations.invitedEmail,
      invitedRole: institutionInvitations.invitedRole,
      status: institutionInvitations.status,
      expiresAt: institutionInvitations.expiresAt,
      createdAt: institutionInvitations.createdAt,
    })
    .from(institutionInvitations)
    .where(
      and(
        eq(institutionInvitations.institutionId, institutionId),
        // Show both live states so the admin can see (and cancel) a not-yet-claimed invite.
        inArray(institutionInvitations.status, ["pending", "pending_claim"]),
      ),
    )
    .orderBy(institutionInvitations.createdAt);
};
