import { Resend } from "resend";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-verification/verification-email");

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? "http://localhost:3000";
};

const buildDashboardUrl = (): string => {
  return new URL("/institution/create", resolveBaseUrl()).toString();
};

const buildContactUrl = (): string => {
  return new URL("/bantuan", resolveBaseUrl()).toString();
};

export const sendInstitutionVerifiedEmail = async (options: {
  toEmail: string;
  institutionDisplayName: string;
}): Promise<void> => {
  if (!serverEnv.resendApiKey || !serverEnv.authEmailFrom) {
    throw new Error("Resend email provider is not fully configured");
  }

  const dashboardUrl = buildDashboardUrl();
  const resend = new Resend(serverEnv.resendApiKey);

  const { error } = await resend.emails.send({
    from: serverEnv.authEmailFrom,
    to: options.toEmail,
    subject: `${options.institutionDisplayName} telah terverifikasi di Lombakita`,
    text: [
      `Selamat! Institusi ${options.institutionDisplayName} Anda telah berhasil diverifikasi di Lombakita.`,
      "",
      "Anda kini dapat memublikasikan kompetisi dan mengelola anggota tim melalui dasbor institusi.",
      "",
      `Mulai sekarang: ${dashboardUrl}`,
      "",
      "Terima kasih telah bergabung dengan Lombakita.",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #0f1012;">
        <h2 style="margin-bottom: 12px;">Institusi terverifikasi</h2>
        <p style="margin: 0 0 12px;">
          Selamat! Institusi <strong>${options.institutionDisplayName}</strong> Anda telah berhasil diverifikasi di Lombakita.
        </p>
        <p style="margin: 0 0 12px;">
          Anda kini dapat memublikasikan kompetisi dan mengelola anggota tim melalui dasbor institusi.
        </p>
        <p style="margin: 0 0 16px;">
          <a href="${dashboardUrl}" style="background: #355795; color: #f4f8ff; text-decoration: none; padding: 10px 16px; border-radius: 8px; display: inline-block;">
            Buka dasbor
          </a>
        </p>
        <p style="margin: 0; color: #4a5565;">Terima kasih telah bergabung dengan Lombakita.</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend verified email dispatch failed: ${error.message}`);
  }

  logger.info("institution.verified.email_sent", {
    institutionDisplayName: options.institutionDisplayName,
    toEmail: options.toEmail,
  });
};

export const sendInstitutionRejectedEmail = async (options: {
  toEmail: string;
  institutionDisplayName: string;
  rejectionReason: string;
}): Promise<void> => {
  if (!serverEnv.resendApiKey || !serverEnv.authEmailFrom) {
    throw new Error("Resend email provider is not fully configured");
  }

  const contactUrl = buildContactUrl();
  const resend = new Resend(serverEnv.resendApiKey);

  const { error } = await resend.emails.send({
    from: serverEnv.authEmailFrom,
    to: options.toEmail,
    subject: `Permohonan verifikasi ${options.institutionDisplayName} ditolak`,
    text: [
      `Permohonan verifikasi untuk institusi ${options.institutionDisplayName} tidak dapat disetujui saat ini.`,
      "",
      `Alasan penolakan: ${options.rejectionReason}`,
      "",
      "Jika Anda memiliki pertanyaan atau ingin mengajukan banding, silakan hubungi tim dukungan kami:",
      contactUrl,
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #0f1012;">
        <h2 style="margin-bottom: 12px;">Permohonan verifikasi ditolak</h2>
        <p style="margin: 0 0 12px;">
          Permohonan verifikasi untuk institusi <strong>${options.institutionDisplayName}</strong> tidak dapat disetujui saat ini.
        </p>
        <div style="background: #f5f5f5; border-left: 3px solid #d00; padding: 10px 14px; margin: 0 0 16px; border-radius: 0 6px 6px 0;">
          <p style="margin: 0; font-weight: bold; font-size: 13px; color: #555;">Alasan penolakan</p>
          <p style="margin: 6px 0 0; font-size: 14px;">${options.rejectionReason}</p>
        </div>
        <p style="margin: 0 0 16px;">
          Jika Anda memiliki pertanyaan atau ingin mengajukan banding, silakan hubungi tim dukungan kami.
        </p>
        <p style="margin: 0 0 16px;">
          <a href="${contactUrl}" style="background: #355795; color: #f4f8ff; text-decoration: none; padding: 10px 16px; border-radius: 8px; display: inline-block;">
            Hubungi dukungan
          </a>
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend rejected email dispatch failed: ${error.message}`);
  }

  logger.info("institution.rejected.email_sent", {
    institutionDisplayName: options.institutionDisplayName,
    toEmail: options.toEmail,
  });
};
