import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-close-notices");

import { Resend } from "resend";
import { formatWib } from "@/lib/dates/date-format";
import { logger } from "@/lib/logger";
import { resolveBaseUrl } from "@/server/auth/email-verification";
import { resolveEmailDelivery } from "@/server/email/delivery";
import { throwEmailSendFailure } from "@/server/email/send-failure";

export const JOIN_REMINDER_LEAD_HOURS = 24;

// The title is both the inbox title and the email subject, and the body is both the inbox body and
// the email's first paragraph, so the two channels cannot say different things.
export type TeamCloseNotice = { title: string; body: string };

export type TeamCloseNoticeKind = "team_join_reminder" | "team_cancelled_below_minimum";

export type TeamShortfall = { missingMemberCount: number; minTeamSize: number };

export const buildTeamPagePath = (institutionSlug: string, competitionSlug: string): string =>
  `/competitions/${institutionSlug}/${competitionSlug}/registration`;

const sentencesAboutTheShortfall = (shortfall: TeamShortfall | null): string[] => {
  if (shortfall === null) {
    return ["Undangan yang belum diterima sampai saat itu tidak dapat diterima lagi."];
  }

  return [
    `Tim Anda masih membutuhkan ${shortfall.missingMemberCount} anggota lagi untuk mencapai jumlah minimal ${shortfall.minTeamSize} anggota.`,
    "Jika sampai saat itu jumlah anggota masih kurang, pendaftaran tim dibatalkan secara otomatis.",
  ];
};

export const buildTeamJoinReminderNotice = (input: {
  competitionTitle: string;
  closesAt: Date;
  pendingInviteeEmails: string[];
  shortfall: TeamShortfall | null;
}): TeamCloseNotice => {
  const hasPendingInvitees = input.pendingInviteeEmails.length > 0;
  const closeSentence = `Pendaftaran ditutup pada ${formatWib(input.closesAt, "longDateTime")} WIB.`;
  const pendingSentence = `Undangan untuk ${input.pendingInviteeEmails.join(", ")} belum diterima.`;
  const whatTheCaptainCanStillDo = hasPendingInvitees
    ? "Anda masih dapat membatalkan undangan dan mengundang orang lain sebelum pendaftaran ditutup."
    : "Anda masih dapat mengundang anggota baru sebelum pendaftaran ditutup.";

  const sentences = [
    closeSentence,
    ...(hasPendingInvitees ? [pendingSentence] : []),
    ...sentencesAboutTheShortfall(input.shortfall),
    whatTheCaptainCanStillDo,
  ];

  return {
    title: `Pendaftaran ${input.competitionTitle} ditutup dalam ${JOIN_REMINDER_LEAD_HOURS} jam`,
    body: sentences.join(" "),
  };
};

// Nobody decided this cancellation, so the notice names the close as the cause and says the
// organiser did not do it, as the payment expiry notice does.
export const buildTeamCancelledBelowMinimumNotice = (input: {
  competitionTitle: string;
  memberCount: number;
  minTeamSize: number;
}): TeamCloseNotice => {
  const sentences = [
    `Saat pendaftaran ditutup, tim Anda baru memiliki ${input.memberCount} anggota, kurang dari jumlah minimal ${input.minTeamSize} anggota.`,
    "Karena itu pendaftaran tim dibatalkan secara otomatis.",
    "Tim Anda tetap ada bersama anggota yang sudah bergabung.",
    "Pembatalan ini tidak dilakukan oleh penyelenggara dan bukan atas permintaan Anda.",
  ];

  return {
    title: `Pendaftaran tim dibatalkan otomatis untuk ${input.competitionTitle}`,
    body: sentences.join(" "),
  };
};

export const sendTeamCloseNoticeEmail = async (options: {
  kind: TeamCloseNoticeKind;
  toEmail: string;
  recipientId: string;
  notice: TeamCloseNotice;
  teamPagePath: string;
}): Promise<void> => {
  const delivery = resolveEmailDelivery({ kind: options.kind, to: options.toEmail });

  if (!delivery) {
    return;
  }

  const resend = new Resend(delivery.apiKey);
  const { error } = await resend.emails.send({
    from: delivery.from,
    to: options.toEmail,
    subject: options.notice.title,
    text: [
      options.notice.body,
      "",
      `Buka tim Anda di ${resolveBaseUrl()}${options.teamPagePath}.`,
    ].join("\n"),
  });

  if (error) {
    throwEmailSendFailure(options.kind, error);
  }

  logger.info("notification.sent", { event: options.kind, recipientId: options.recipientId });
};
