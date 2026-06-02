import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/notifications/notification-email");

import { Resend } from "resend";
import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

const assertResendConfigured = (): { apiKey: string; from: string } => {
  if (!serverEnv.resendApiKey || !serverEnv.authEmailFrom) {
    throw new Error("Resend notification email provider is not fully configured");
  }
  return { apiKey: serverEnv.resendApiKey, from: serverEnv.authEmailFrom };
};

export const sendRegistrationConfirmedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  registrationType: "individual" | "team";
  registeredAt: Date;
}): Promise<void> => {
  const { apiKey, from } = assertResendConfigured();
  const typeLabel = options.registrationType === "team" ? "Tim" : "Individu";
  const dateFormatted = options.registeredAt.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Pendaftaran kamu berhasil — ${options.competitionTitle}`,
    text: [
      `Pendaftaran kamu untuk kompetisi "${options.competitionTitle}" telah berhasil.`,
      "",
      `Jenis Pendaftaran: ${typeLabel}`,
      `Tanggal Daftar: ${dateFormatted}`,
      "",
      `Pantau perkembangan kompetisi kamu di ${resolveBaseUrl()}.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend registration confirmed email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "registration.confirmed",
    recipientId: options.recipientId,
  });
};

export const sendRegistrationCancelledEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  registrationType: "individual" | "team";
}): Promise<void> => {
  const { apiKey, from } = assertResendConfigured();
  const typeLabel = options.registrationType === "team" ? "tim" : "individu";

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Pendaftaran kamu dibatalkan — ${options.competitionTitle}`,
    text: [
      `Pendaftaran ${typeLabel} kamu untuk kompetisi "${options.competitionTitle}" telah dibatalkan.`,
      "",
      `Kunjungi ${resolveBaseUrl()} untuk melihat kompetisi lainnya.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend registration cancelled email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "registration.cancelled",
    recipientId: options.recipientId,
  });
};

export const sendSubmissionFinalizedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  competitionTitle: string;
  finalizedAt: Date;
}): Promise<void> => {
  const { apiKey, from } = assertResendConfigured();
  const dateFormatted = options.finalizedAt.toLocaleString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Pengiriman kamu telah dikunci — ${options.competitionTitle}`,
    text: [
      `Pengiriman kamu untuk kompetisi "${options.competitionTitle}" telah dikunci pada ${dateFormatted}.`,
      "",
      "Pengiriman yang telah dikunci tidak dapat diubah.",
      "",
      `Pantau perkembangan kompetisi kamu di ${resolveBaseUrl()}.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend submission finalized email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "submission.finalized",
    recipientId: options.recipientId,
  });
};

export const sendResultPublishedEmail = async (options: {
  toEmail: string;
  recipientId: string;
  displayName: string | null;
  competitionTitle: string;
}): Promise<void> => {
  const { apiKey, from } = assertResendConfigured();
  const greeting = options.displayName ? `Hai ${options.displayName},` : "Hai,";

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: options.toEmail,
    subject: `Hasil kompetisi telah diumumkan — ${options.competitionTitle}`,
    text: [
      greeting,
      "",
      `Hasil kompetisi "${options.competitionTitle}" telah diumumkan.`,
      "",
      `Cek hasilmu di ${resolveBaseUrl()}.`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend result published email dispatch failed: ${error.message}`);
  }

  logger.info("notification.sent", {
    event: "result.published",
    recipientId: options.recipientId,
  });
};
