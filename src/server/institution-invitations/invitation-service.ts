import { and, eq, inArray } from "drizzle-orm";
import type { AppRole } from "@/lib/access/roles";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionInvitations,
  institutionMemberships,
  institutions,
  users,
} from "@/server/db/schema";
import { logger } from "@/lib/logger";
import {
  buildInvitationExpiresAt,
  generateRawToken,
  hashToken,
  InstitutionInvitationError,
  maskToken,
  parseInvitationCreateInput,
  RECRUITER_VERIFIED_ROLES,
  type InstitutionInvitationMeta,
  type InvitationCreateInput,
} from "@/server/institution-invitations/invitation-core";
import { sendInstitutionInvitationEmail } from "@/server/institution-invitations/invitation-email";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-invitations/invitation-service");

const ADMIN_ROLES = ["institution_owner", "institution_staff"] as const;

const requireAdminInstitution = async (
  userId: string,
  institutionSlug: string,
  db: Database,
): Promise<{ institutionId: string; institutionDisplayName: string }> => {
  const [row] = await db
    .select({
      institutionId: institutions.id,
      institutionDisplayName: institutions.displayName,
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
  const { institutionId, institutionDisplayName } = await requireAdminInstitution(
    userId,
    institutionSlug,
    db,
  );

  const [existingMember] = await db
    .select({ membershipId: institutionMemberships.id })
    .from(institutionMemberships)
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(users.email, input.invitedEmail),
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

  const [existingPending] = await db
    .select({ id: institutionInvitations.id })
    .from(institutionInvitations)
    .where(
      and(
        eq(institutionInvitations.institutionId, institutionId),
        eq(institutionInvitations.invitedEmail, input.invitedEmail),
        eq(institutionInvitations.status, "pending"),
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
      invitedEmail: input.invitedEmail,
      invitedRole: input.invitedRole,
      tokenHash,
      status: "pending",
      invitedByUserId: userId,
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

  await sendInstitutionInvitationEmail({
    toEmail: input.invitedEmail,
    institutionDisplayName,
    invitedRole: input.invitedRole,
    rawToken,
    expiresAt,
  });

  return invitation;
};

export const getInvitationMetaByToken = async (
  rawToken: string,
  db: Database = getDb(),
): Promise<InstitutionInvitationMeta> => {
  const tokenHash = hashToken(rawToken);

  const [row] = await db
    .select({
      id: institutionInvitations.id,
      institutionId: institutionInvitations.institutionId,
      institutionDisplayName: institutions.displayName,
      invitedEmail: institutionInvitations.invitedEmail,
      invitedRole: institutionInvitations.invitedRole,
      status: institutionInvitations.status,
      expiresAt: institutionInvitations.expiresAt,
      createdAt: institutionInvitations.createdAt,
    })
    .from(institutionInvitations)
    .innerJoin(institutions, eq(institutions.id, institutionInvitations.institutionId))
    .where(eq(institutionInvitations.tokenHash, tokenHash))
    .limit(1);

  if (!row) {
    throw new InstitutionInvitationError("invitation_not_found", 404, "Invitation not found");
  }

  return row;
};

export const acceptInvitation = async (
  rawToken: string,
  userId: string,
  sessionVerifiedRoles: AppRole[],
  db: Database = getDb(),
): Promise<void> => {
  const tokenHash = hashToken(rawToken);

  await db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(institutionInvitations)
      .where(eq(institutionInvitations.tokenHash, tokenHash))
      .limit(1);

    if (!invitation) {
      throw new InstitutionInvitationError("invitation_not_found", 404, "Invitation not found");
    }

    if (invitation.status !== "pending") {
      if (invitation.status === "accepted") {
        logger.info("invitation.already_accepted", { tokenPrefix: maskToken(rawToken) });
      }
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
      logger.info("invitation.expired_on_attempt", { tokenPrefix: maskToken(rawToken) });
      throw new InstitutionInvitationError(
        "invitation_not_actionable",
        410,
        "Invitation has expired",
      );
    }

    // CCR-07 / CCR-08 / DEC-0042: Verify the accepting account holds the required verified
    // role, read from session.user.verifiedRoles (no DB re-query per Step 2.3 spec).
    // institution_owner and institution_staff invites require "recruiter" in verifiedRoles —
    // independent of the active role-mode, so an account that holds both candidate and
    // recruiter verifications passes regardless of which mode is currently active.
    // institution_member invites accept any authenticated account (session existence implies
    // at least one verified role per DB CHECK users_one_verified_role_chk).
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

    const [existingMembership] = await tx
      .select({ id: institutionMemberships.id })
      .from(institutionMemberships)
      .where(
        and(
          eq(institutionMemberships.userId, userId),
          eq(institutionMemberships.institutionId, invitation.institutionId),
        ),
      )
      .limit(1);

    if (existingMembership) {
      throw new InstitutionInvitationError(
        "invitation_already_member",
        409,
        "You are already a member of this institution",
      );
    }

    await tx.insert(institutionMemberships).values({
      institutionId: invitation.institutionId,
      userId,
      membershipRole: invitation.invitedRole,
      status: "active",
      invitedByUserId: invitation.invitedByUserId,
    });

    await tx
      .update(institutionInvitations)
      .set({ status: "accepted", acceptedAt: now })
      .where(eq(institutionInvitations.id, invitation.id));

    logger.info("invitation.accepted", {
      institutionId: invitation.institutionId,
      invitedRole: invitation.invitedRole,
    });
  });
};

export const declineInvitation = async (
  rawToken: string,
  db: Database = getDb(),
): Promise<void> => {
  const tokenHash = hashToken(rawToken);

  const [invitation] = await db
    .select({
      id: institutionInvitations.id,
      status: institutionInvitations.status,
      expiresAt: institutionInvitations.expiresAt,
    })
    .from(institutionInvitations)
    .where(eq(institutionInvitations.tokenHash, tokenHash))
    .limit(1);

  if (!invitation) {
    throw new InstitutionInvitationError("invitation_not_found", 404, "Invitation not found");
  }

  if (invitation.status !== "pending") {
    throw new InstitutionInvitationError(
      "invitation_not_actionable",
      410,
      `Invitation is ${invitation.status} and cannot be declined`,
    );
  }

  const now = new Date();
  if (invitation.expiresAt < now) {
    await db
      .update(institutionInvitations)
      .set({ status: "expired" })
      .where(eq(institutionInvitations.id, invitation.id));
    throw new InstitutionInvitationError(
      "invitation_not_actionable",
      410,
      "Invitation has expired",
    );
  }

  await db
    .update(institutionInvitations)
    .set({ status: "declined" })
    .where(eq(institutionInvitations.id, invitation.id));

  logger.info("invitation.declined", { tokenPrefix: maskToken(rawToken) });
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

  if (invitation.status !== "pending") {
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
        eq(institutionInvitations.status, "pending"),
      ),
    )
    .orderBy(institutionInvitations.createdAt);
};
