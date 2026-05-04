import { Resend } from "resend";
import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-invitations/invitation-email");

const ROLE_LABELS: Record<string, string> = {
  institution_staff: "Staf Institusi",
};

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

const buildAcceptanceUrl = (rawToken: string): string => {
  const baseUrl = resolveBaseUrl();
  const url = new URL(`/invitations/${encodeURIComponent(rawToken)}/accept`, baseUrl);
  return url.toString();
};

const formatExpiryDate = (expiresAt: Date): string => {
  return expiresAt.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

export const sendInstitutionInvitationEmail = async (options: {
  toEmail: string;
  institutionDisplayName: string;
  invitedRole: string;
  rawToken: string;
  expiresAt: Date;
}): Promise<void> => {
  if (!serverEnv.resendApiKey || !serverEnv.authEmailFrom) {
    throw new Error("Resend invitation email provider is not fully configured");
  }

  const acceptanceUrl = buildAcceptanceUrl(options.rawToken);
  const roleLabel = ROLE_LABELS[options.invitedRole] ?? options.invitedRole;
  const expiryFormatted = formatExpiryDate(options.expiresAt);

  const resend = new Resend(serverEnv.resendApiKey);

  const { error } = await resend.emails.send({
    from: serverEnv.authEmailFrom,
    to: options.toEmail,
    subject: `Undangan bergabung ke ${options.institutionDisplayName} di Lombakita`,
    text: [
      `Anda diundang untuk bergabung ke ${options.institutionDisplayName} sebagai ${roleLabel} di Lombakita.`,
      "",
      "Klik tautan berikut untuk menerima undangan:",
      acceptanceUrl,
      "",
      `Undangan ini berlaku hingga ${expiryFormatted}.`,
      "",
      "Jika Anda tidak merasa diundang, abaikan email ini.",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #0f1012;">
        <h2 style="margin-bottom: 12px;">Undangan Lombakita</h2>
        <p style="margin: 0 0 12px;">
          Anda diundang untuk bergabung ke <strong>${options.institutionDisplayName}</strong>
          sebagai <strong>${roleLabel}</strong>.
        </p>
        <p style="margin: 0 0 16px;">
          <a href="${acceptanceUrl}" style="background: #355795; color: #f4f8ff; text-decoration: none; padding: 10px 16px; border-radius: 8px; display: inline-block;">
            Terima Undangan
          </a>
        </p>
        <p style="margin: 0 0 10px;">Atau gunakan tautan ini:</p>
        <p style="word-break: break-all; margin: 0 0 12px;">
          <a href="${acceptanceUrl}">${acceptanceUrl}</a>
        </p>
        <p style="margin: 0; color: #4a5565;">Undangan ini berlaku hingga ${expiryFormatted}.</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend email dispatch failed: ${error.message}`);
  }

  logger.info("invitation.created", {
    institutionDisplayName: options.institutionDisplayName,
    invitedRole: options.invitedRole,
    toEmail: options.toEmail,
  });
};
