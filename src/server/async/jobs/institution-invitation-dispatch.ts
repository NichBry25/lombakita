import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/institution-invitation-dispatch");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { institutionInvitations, institutions } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import {
  ASYNC_JOB_NAMES,
  type InstitutionInvitationDispatchPayload,
} from "@/server/async/contracts";
import { sendInstitutionInvitationEmail } from "@/server/institution-invitations/invitation-email";

export type InstitutionInvitationDispatchJob = Job<
  InstitutionInvitationDispatchPayload,
  void,
  typeof ASYNC_JOB_NAMES.institutionInvitationDispatch
>;

// Step 6.5e — queued send for an institution invitation (the email half of the dual channel; the
// in-app inbox entry is already live via target_user_id at creation). The email variant is derived
// from the invitation's CURRENT status so a row cancelled/accepted/claimed between enqueue and run
// is never emailed stale:
//   pending       → targeted email (recipient has an account; link to inbox)
//   pending_claim → claim email (no account yet; link to /auth/login?invite=<rawToken>)
//   anything else → skip (cancelled / declined / accepted / expired)
// A Resend failure rethrows so BullMQ retries (transactional email reliability), consistent with the
// Step 6.1 notification workers.
export const processInstitutionInvitationDispatchJob = async (
  job: InstitutionInvitationDispatchJob,
): Promise<void> => {
  const { invitationId, rawToken } = job.data;
  const db = getDb();

  const [invitation] = await db
    .select({
      invitedEmail: institutionInvitations.invitedEmail,
      invitedRole: institutionInvitations.invitedRole,
      status: institutionInvitations.status,
      expiresAt: institutionInvitations.expiresAt,
      institutionDisplayName: institutions.displayName,
    })
    .from(institutionInvitations)
    .innerJoin(institutions, eq(institutions.id, institutionInvitations.institutionId))
    .where(eq(institutionInvitations.id, invitationId))
    .limit(1);

  if (!invitation) {
    logger.warn("invitation.dispatch.skipped", {
      reason: "invitation_not_found",
      jobId: job.id,
      invitationId,
    });
    return;
  }

  if (invitation.status !== "pending" && invitation.status !== "pending_claim") {
    logger.warn("invitation.dispatch.skipped", {
      reason: "not_sendable_status",
      status: invitation.status,
      jobId: job.id,
      invitationId,
    });
    return;
  }

  const mode = invitation.status === "pending_claim" ? "claim" : "targeted";

  await sendInstitutionInvitationEmail({
    toEmail: invitation.invitedEmail,
    institutionDisplayName: invitation.institutionDisplayName,
    invitedRole: invitation.invitedRole,
    expiresAt: invitation.expiresAt,
    mode,
    rawToken: mode === "claim" ? rawToken : undefined,
  });
};
