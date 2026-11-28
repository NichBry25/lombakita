import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/institution-tick-notice");

import { and, asc, eq, sql } from "drizzle-orm";
import type { Job } from "bullmq";
import { absoluteSiteUrl } from "@/config/site-url";
import { formatWib } from "@/lib/dates/date-format";
import { asSentence } from "@/lib/finance/payment-display";
import { logger } from "@/lib/logger";
import {
  ASYNC_JOB_NAMES,
  type InstitutionTickNoticeKind,
  type InstitutionTickNoticePayload,
} from "@/server/async/contracts";
import { getDb } from "@/server/db/client";
import { institutionMemberships, institutions, users } from "@/server/db/schema";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { sendInstitutionTickNoticeEmail } from "@/server/notifications/notification-email";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type InstitutionTickNoticeJob = Job<
  InstitutionTickNoticePayload,
  void,
  typeof ASYNC_JOB_NAMES.institutionTickNotice
>;

type NoticeWords = { title: string; body: string };

type NoticeFillers = {
  name: string;
  date: string;
  reason: string | undefined;
  institutionSlug: string;
};

const REVOKED_TITLE = "Centang ruang kerja dicabut";
const PAID_BLOCKED_SENTENCE =
  "Kompetisi berbayar baru tidak dapat diterbitkan sampai centang didapat lagi.";

const turnedDownWordsOf = (reason: string | undefined): NoticeWords => ({
  title: "Permintaan centang belum disetujui",
  body: reason
    ? `Catatan staf: ${asSentence(reason)} Perbaiki lalu kirim lagi.`
    : "Periksa lagi syarat jalur yang Anda pilih lalu kirim lagi.",
});

// Each notice is worded once and used for both channels. A staff reason is free text, so it goes
// through asSentence before the next sentence.
const noticeWordsOf = (kind: InstitutionTickNoticeKind, fillers: NoticeFillers): NoticeWords => {
  const { name, date, reason, institutionSlug } = fillers;
  const staffReason = asSentence(reason ?? "");

  switch (kind) {
    case "tick_granted":
      return {
        title: "Ruang kerja Anda terverifikasi",
        body: `${name} kini memiliki centang terverifikasi.`,
      };
    case "tick_request_turned_down":
      return turnedDownWordsOf(reason);
    case "tick_revoked":
      return { title: REVOKED_TITLE, body: `Alasan: ${staffReason} ${PAID_BLOCKED_SENTENCE}` };
    case "tick_removed_name_proof":
      return {
        title: REVOKED_TITLE,
        body: `Bukti nama ${name} tidak kami terima dalam 28 hari. ${PAID_BLOCKED_SENTENCE}`,
      };
    case "name_checked":
      return {
        title: "Nama ruang kerja sudah diperiksa",
        body: `Kompetisi berbayar ${name} kini dapat diterbitkan. Buka drafnya lalu tekan Terbitkan.`,
      };
    case "name_proof_requested":
      return {
        title: "Buktikan nama ruang kerja Anda",
        body: `Staf meminta bukti bahwa ${name} berhak memakai nama ini. Catatan staf: ${staffReason} Kirim dokumen sebagai bukti sebelum ${date}. Tanpa bukti, centang dicabut otomatis.`,
      };
    case "name_proof_reminder":
      return {
        title: "Sisa 7 hari untuk bukti nama",
        body: `Kirim dokumen sebagai bukti nama ${name} sebelum ${date}. Tanpa bukti, centang dicabut otomatis.`,
      };
    case "renamed_by_staff":
      return {
        title: "Nama ruang kerja diubah staf",
        body: `Nama: ${name}. Alamat: ${absoluteSiteUrl(`/institution/${institutionSlug}`)}. Alasan: ${staffReason}`,
      };
  }
};

const readWorkspace = async (payload: InstitutionTickNoticePayload) => {
  const [workspace] = await getDb()
    .select({
      displayName: institutions.displayName,
      slug: institutions.slug,
      verificationStatus: institutions.verificationStatus,
      tickPath: institutions.tickPath,
      dueDateEqualsPayload: sql<
        boolean | null
      >`${institutions.nameProofDueAt} = ${payload.dueAt ?? null}::timestamptz`,
    })
    .from(institutions)
    .where(eq(institutions.id, payload.institutionId))
    .limit(1);
  return workspace ?? null;
};

const readActiveOwners = async (institutionId: string) =>
  getDb()
    .select({ id: users.id, email: users.email })
    .from(institutionMemberships)
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.membershipRole, "institution_owner"),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .orderBy(asc(institutionMemberships.createdAt));

type ActiveOwner = Awaited<ReturnType<typeof readActiveOwners>>[number];

const logSkipped = (
  job: InstitutionTickNoticeJob,
  reason: "institution_not_found" | "no_active_owner" | "name_proof_ended",
): void => {
  logger.warn("institution_tick.notice_skipped", {
    jobId: job.id,
    institutionId: job.data.institutionId,
    reason,
  });
};

const dateOf = (dueAt: string | undefined): string =>
  dueAt === undefined ? "" : formatWib(dueAt, "longDate");

// The inbox rows are written once. The job's data records that they were, so a retry after a
// failed email writes no row again.
const writeInboxRowsOnce = async (
  job: InstitutionTickNoticeJob,
  owners: ActiveOwner[],
  words: NoticeWords,
): Promise<void> => {
  if (job.data.inboxWritten === true) return;

  for (const owner of owners) {
    await writeInboxNotificationSafely(
      getDb(),
      {
        userId: owner.id,
        type: NOTIFICATION_TYPES.institutionTickNotice,
        title: words.title,
        body: words.body,
      },
      { event: "institution.tick.notice", jobId: job.id ?? undefined },
    );
  }
  await job.updateData({ ...job.data, inboxWritten: true });
};

// Tells every active owner of a workspace about a staff decision, or about the clock of a name
// proof: the inbox row first for every owner, then the emails. A reminder is dropped when its proof
// ended after the sweep queued it.
export const processInstitutionTickNoticeJob = async (
  job: InstitutionTickNoticeJob,
): Promise<void> => {
  const { institutionId, kind, reason, dueAt } = job.data;

  const workspace = await readWorkspace(job.data);
  if (!workspace) {
    logSkipped(job, "institution_not_found");
    return;
  }

  if (kind === "name_proof_reminder") {
    const proofStillRuns =
      workspace.verificationStatus === "verified" &&
      workspace.tickPath === "domain" &&
      workspace.dueDateEqualsPayload === true;
    if (!proofStillRuns) {
      logSkipped(job, "name_proof_ended");
      return;
    }
  }

  const owners = await readActiveOwners(institutionId);
  if (owners.length === 0) {
    logSkipped(job, "no_active_owner");
    return;
  }

  const { title, body } = noticeWordsOf(kind, {
    name: workspace.displayName,
    date: dateOf(dueAt),
    reason,
    institutionSlug: workspace.slug,
  });

  await writeInboxRowsOnce(job, owners, { title, body });

  for (const owner of owners) {
    try {
      await sendInstitutionTickNoticeEmail({
        toEmail: owner.email,
        recipientId: owner.id,
        title,
        body,
        institutionSlug: workspace.slug,
      });
    } catch (error) {
      logger.error("notification.failed", {
        event: "institution.tick.notice",
        jobId: job.id,
        recipientId: owner.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
};
