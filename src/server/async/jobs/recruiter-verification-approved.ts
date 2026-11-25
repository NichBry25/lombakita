import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/recruiter-verification-approved");

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb, type Database } from "@/server/db/client";
import { competitions, institutionMemberships, institutions, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import {
  ASYNC_JOB_NAMES,
  type RecruiterVerificationApprovedPayload,
} from "@/server/async/contracts";
import { sendRecruiterVerificationApprovedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";
import { runsInstitutionOfCompetition } from "@/server/host-trust/host-check-drafts";

export type RecruiterVerificationApprovedJob = Job<
  RecruiterVerificationApprovedPayload,
  void,
  typeof ASYNC_JOB_NAMES.recruiterVerificationApproved
>;

type ApprovalNotice = { title: string; body: string; path: string };

const TRUST_RAISE_TITLE = "Akun Anda kini penyelenggara tepercaya";
const HOST_CHECK_APPROVED_TITLE = "Kompetisi Anda lolos pemeriksaan";
const DASHBOARD_PATH = "/recruiter-dashboard";

const draftPathOf = (institutionSlug: string, competitionSlug: string): string =>
  `/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionSlug)}`;

const publicPathOf = (institutionSlug: string, competitionSlug: string): string =>
  `/competitions/${encodeURIComponent(institutionSlug)}/${encodeURIComponent(competitionSlug)}`;

const findNewestDraftOf = async (db: Database, userId: string) => {
  const [draft] = await db
    .select({
      title: competitions.title,
      slug: competitions.slug,
      institutionSlug: institutions.slug,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .innerJoin(institutionMemberships, runsInstitutionOfCompetition(userId))
    .where(
      and(
        eq(competitions.createdByUserId, userId),
        eq(competitions.status, "draft"),
        isNull(competitions.deletedAt),
      ),
    )
    .orderBy(desc(competitions.createdAt))
    .limit(1);

  return draft ?? null;
};

const findLiveCompetition = async (db: Database, userId: string, competitionId: string) => {
  const [competition] = await db
    .select({
      title: competitions.title,
      slug: competitions.slug,
      status: competitions.status,
      institutionSlug: institutions.slug,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .innerJoin(institutionMemberships, runsInstitutionOfCompetition(userId))
    .where(and(eq(competitions.id, competitionId), isNull(competitions.deletedAt)))
    .limit(1);

  return competition ?? null;
};

// The staff raise. The newest draft is read when the job runs, so the notice points at what the host
// has at that moment, and only at a draft of an institution the host still runs as owner or staff.
const buildTrustRaiseNotice = async (db: Database, userId: string): Promise<ApprovalNotice> => {
  const draft = await findNewestDraftOf(db, userId);
  if (!draft) {
    return {
      title: TRUST_RAISE_TITLE,
      body: "Anda sekarang dapat menerbitkan kompetisi dari dasbor penyelenggara.",
      path: DASHBOARD_PATH,
    };
  }
  return {
    title: TRUST_RAISE_TITLE,
    body: `Anda sekarang dapat menerbitkan kompetisi. Buka draf "${draft.title}" lalu tekan Terbitkan.`,
    path: draftPathOf(draft.institutionSlug, draft.slug),
  };
};

// A host check approval. The competition is read when the job runs, so the notice says whether the
// approval's publish went through. A draft of an institution the host no longer runs as owner or
// staff is not named.
const buildHostCheckApprovalNotice = async (
  db: Database,
  userId: string,
  competitionId: string,
): Promise<ApprovalNotice> => {
  const competition = await findLiveCompetition(db, userId, competitionId);
  if (competition?.status === "published") {
    return {
      title: HOST_CHECK_APPROVED_TITLE,
      body: `Akun Anda kini tepercaya dan "${competition.title}" sudah tayang.`,
      path: publicPathOf(competition.institutionSlug, competition.slug),
    };
  }
  if (competition?.status === "draft") {
    return {
      title: HOST_CHECK_APPROVED_TITLE,
      body: `Akun Anda kini tepercaya. Buka draf "${competition.title}" lalu tekan Terbitkan.`,
      path: draftPathOf(competition.institutionSlug, competition.slug),
    };
  }
  return {
    title: HOST_CHECK_APPROVED_TITLE,
    body: "Akun Anda kini tepercaya. Kompetisi yang Anda terbitkan langsung tayang.",
    path: DASHBOARD_PATH,
  };
};

// Tells a host their account may now publish, after the staff raise or a host check approval.
export const processRecruiterVerificationApprovedJob = async (
  job: RecruiterVerificationApprovedJob,
): Promise<void> => {
  const { userId, competitionId } = job.data;

  const db = getDb();

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    logger.warn("notification.failed", {
      event: "recruiter.verification.approved",
      reason: "user_not_found",
      jobId: job.id,
      userId,
    });
    return;
  }

  const notice =
    competitionId === undefined
      ? await buildTrustRaiseNotice(db, userId)
      : await buildHostCheckApprovalNotice(db, userId, competitionId);

  // Dual-channel (DEC-0076): in-app row written FIRST, isolated and swallowed. The email block keeps
  // its rethrow-for-retry semantics so the row lands regardless of email outcome.
  await writeInboxNotificationSafely(
    db,
    {
      userId,
      type: NOTIFICATION_TYPES.recruiterVerificationApproved,
      title: notice.title,
      body: notice.body,
    },
    { event: "recruiter.verification.approved", jobId: job.id ?? undefined },
  );

  try {
    await sendRecruiterVerificationApprovedEmail({
      toEmail: user.email,
      recipientId: userId,
      ...notice,
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "recruiter.verification.approved",
      jobId: job.id,
      recipientId: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
