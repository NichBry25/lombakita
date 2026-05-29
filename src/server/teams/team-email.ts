import { Resend } from "resend";
import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-email");

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

const buildInviteUrl = (rawToken: string): string => {
  const baseUrl = resolveBaseUrl();
  const url = new URL(`/team-invitations/${encodeURIComponent(rawToken)}`, baseUrl);
  return url.toString();
};

const formatExpiryDate = (expiresAt: Date): string => {
  return expiresAt.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

export const sendTeamInvitationEmail = async (options: {
  toEmail: string;
  teamName: string;
  competitionTitle: string;
  inviterDisplayName: string | null;
  rawToken: string;
  expiresAt: Date;
}): Promise<void> => {
  if (!serverEnv.resendApiKey || !serverEnv.authEmailFrom) {
    throw new Error("Resend team invitation email provider is not fully configured");
  }

  const inviteUrl = buildInviteUrl(options.rawToken);
  const expiryFormatted = formatExpiryDate(options.expiresAt);
  const inviterLabel = options.inviterDisplayName ?? "Kapten tim";

  const resend = new Resend(serverEnv.resendApiKey);

  const { error } = await resend.emails.send({
    from: serverEnv.authEmailFrom,
    to: options.toEmail,
    subject: `Undangan tim ${options.teamName} untuk ${options.competitionTitle}`,
    text: [
      `${inviterLabel} mengundang Anda untuk bergabung dengan tim ${options.teamName}`,
      `pada kompetisi ${options.competitionTitle} di Lombakita.`,
      "",
      "Buka tautan berikut untuk menerima atau menolak undangan:",
      inviteUrl,
      "",
      `Undangan ini berlaku hingga ${expiryFormatted}.`,
      "",
      "Jika Anda tidak merasa diundang, abaikan email ini.",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #0f1012;">
        <h2 style="margin-bottom: 12px;">Undangan tim Lombakita</h2>
        <p style="margin: 0 0 12px;">
          <strong>${inviterLabel}</strong> mengundang Anda untuk bergabung dengan tim
          <strong>${options.teamName}</strong> pada kompetisi
          <strong>${options.competitionTitle}</strong>.
        </p>
        <p style="margin: 0 0 16px;">
          <a href="${inviteUrl}" style="background: #355795; color: #f4f8ff; text-decoration: none; padding: 10px 16px; border-radius: 8px; display: inline-block;">
            Lihat Undangan
          </a>
        </p>
        <p style="margin: 0 0 10px;">Atau gunakan tautan ini:</p>
        <p style="word-break: break-all; margin: 0 0 12px;">
          <a href="${inviteUrl}">${inviteUrl}</a>
        </p>
        <p style="margin: 0; color: #4a5565;">Undangan ini berlaku hingga ${expiryFormatted}.</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend team invite email dispatch failed: ${error.message}`);
  }

  logger.info("team_invitation.created", {
    teamName: options.teamName,
    competitionTitle: options.competitionTitle,
    toEmail: options.toEmail,
  });
};
