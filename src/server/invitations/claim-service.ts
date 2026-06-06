import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/invitations/claim-service");

import { and, eq, gt, isNull } from "drizzle-orm";
import { type Database } from "@/server/db/client";
import { institutionInvitations, teamInvitations } from "@/server/db/schema";
import { logger } from "@/lib/logger";

// Accept either the root Drizzle client or an open transaction handle (mirrors
// notification-service.NotificationWriter). Claim-at-signup MUST run inside the same transaction
// that finalizes the account so a half-claimed state cannot occur — callers pass their `tx`.
type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export type ClaimResult = {
  institutionInvitationsClaimed: number;
  teamInvitationsClaimed: number;
};

// Step 6.5e — claim-at-signup. After a brand-new account's email is verified (credentials
// verification completion OR Google finalize), attach every `pending_claim` invitation addressed to
// that email to the new user: set `target_user_id` and flip the status to `pending` so it surfaces
// in the inbox as an actionable invite.
//
// Selection key is the verified email — NOT a token — so a single signup claims every pending invite
// to that address across both systems at once. Guards: `target_user_id IS NULL` (never re-target an
// already-claimed row), `status = 'pending_claim'`, and `expires_at > now` (the single invite-time
// expiry clock governs both states — an expired pending_claim is never claimed; the inviter must
// re-send).
//
// invited_email is stored lowercased at invite creation; we lowercase the incoming email as a
// belt-and-braces match. The same `expiresAt` (`now`) is used for both tables so the claim is a
// single consistent point in time.
export const claimPendingInvitationsForUser = async (
  userId: string,
  email: string,
  db: DbOrTx,
  now: Date = new Date(),
): Promise<ClaimResult> => {
  const normalizedEmail = email.trim().toLowerCase();

  const institutionClaimed = await db
    .update(institutionInvitations)
    .set({ targetUserId: userId, status: "pending" })
    .where(
      and(
        eq(institutionInvitations.invitedEmail, normalizedEmail),
        isNull(institutionInvitations.targetUserId),
        eq(institutionInvitations.status, "pending_claim"),
        gt(institutionInvitations.expiresAt, now),
      ),
    )
    .returning({ id: institutionInvitations.id });

  const teamClaimed = await db
    .update(teamInvitations)
    .set({ targetUserId: userId, status: "pending" })
    .where(
      and(
        eq(teamInvitations.invitedEmail, normalizedEmail),
        isNull(teamInvitations.targetUserId),
        eq(teamInvitations.status, "pending_claim"),
        gt(teamInvitations.expiresAt, now),
      ),
    )
    .returning({ id: teamInvitations.id });

  const result: ClaimResult = {
    institutionInvitationsClaimed: institutionClaimed.length,
    teamInvitationsClaimed: teamClaimed.length,
  };

  if (result.institutionInvitationsClaimed > 0 || result.teamInvitationsClaimed > 0) {
    logger.info("invitation.claimed_at_signup", {
      userId,
      institutionInvitationsClaimed: result.institutionInvitationsClaimed,
      teamInvitationsClaimed: result.teamInvitationsClaimed,
    });
  }

  return result;
};
