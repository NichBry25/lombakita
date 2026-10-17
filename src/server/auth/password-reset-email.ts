import { COMPANY } from "@/config/company";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { resolveBaseUrl } from "@/server/auth/email-verification";
import { resolveEmailDelivery } from "@/server/email/delivery";
import { rethrowSmtpSendFailure } from "@/server/email/send-failure";
import { buildResendSmtpTransport } from "@/server/email/smtp-transport";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/password-reset-email");

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildActionUrl = (path: string): URL => new URL(path, resolveBaseUrl());

// The same inline styles as the registration verification email. Every paragraph is escaped here,
// so a caller passes plain text and never HTML.
const renderEmailHtml = (options: {
  heading: string;
  name: string;
  paragraphs: string[];
  buttonLabel: string;
  actionUrl: string;
  showPlainLink: boolean;
  footer: string | null;
}): string => {
  const paragraphs = options.paragraphs
    .map((paragraph) => `<p style="margin: 0 0 16px;">${escapeHtml(paragraph)}</p>`)
    .join("\n          ");
  const plainLink = options.showPlainLink
    ? `<p style="margin: 0 0 10px;">Atau gunakan tautan ini:</p>
          <p style="word-break: break-all; margin: 0 0 12px;">
            <a href="${options.actionUrl}">${options.actionUrl}</a>
          </p>`
    : "";
  const footer = options.footer
    ? `<p style="margin: 0; color: #3d5c56;">${escapeHtml(options.footer)}</p>`
    : "";

  return `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #14453d;">
          <h2 style="margin-bottom: 12px;">${escapeHtml(options.heading)}</h2>
          <p style="margin: 0 0 12px;">Halo ${escapeHtml(options.name)},</p>
          ${paragraphs}
          <p style="margin: 0 0 16px;">
            <a href="${options.actionUrl}" style="background: #c6491b; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 8px; display: inline-block;">
              ${escapeHtml(options.buttonLabel)}
            </a>
          </p>
          ${plainLink}
          ${footer}
        </div>
      `;
};

export const sendPasswordResetEmail = async (options: {
  email: string;
  name: string;
  rawToken: string;
}): Promise<void> => {
  const actionUrl = buildActionUrl("/auth/reset-password");
  actionUrl.searchParams.set("token", options.rawToken);
  const resetUrl = actionUrl.toString();

  // The reset link is an account credential, and a suppressed send logs whatever it is given. Only a
  // local machine may see it in a log.
  const logActionUrl = serverEnv.appEnv === "local" ? resetUrl : undefined;

  const delivery = resolveEmailDelivery({
    kind: "password_reset",
    to: options.email,
    actionUrl: logActionUrl,
  });

  if (!delivery) {
    return;
  }

  const transporter = buildResendSmtpTransport(delivery.apiKey);

  // The recipient stays inline at the send call: the send-site census resolves the address argument
  // off the call expression, and a hoisted object hides it.
  try {
    await transporter.sendMail({
      from: delivery.from,
      to: options.email,
      subject: "Atur ulang password Lombakita",
      text: [
        `Halo ${options.name},`,
        "",
        "Kami menerima permintaan untuk mengatur ulang password akun Lombakita Anda.",
        "Klik tautan berikut untuk membuat password baru:",
        resetUrl,
        "",
        "Tautan ini berlaku selama 30 menit dan hanya bisa dipakai satu kali. Jika Anda tidak memintanya, abaikan email ini. Password Anda tidak berubah.",
      ].join("\n"),
      html: renderEmailHtml({
        heading: "Atur ulang password Lombakita",
        name: options.name,
        paragraphs: [
          "Kami menerima permintaan untuk mengatur ulang password akun Lombakita Anda. Klik tautan berikut untuk membuat password baru:",
        ],
        buttonLabel: "Atur Ulang Password",
        actionUrl: resetUrl,
        showPlainLink: true,
        footer:
          "Tautan ini berlaku selama 30 menit dan hanya bisa dipakai satu kali. Jika Anda tidak memintanya, abaikan email ini. Password Anda tidak berubah.",
      }),
    });
  } catch (error: unknown) {
    rethrowSmtpSendFailure("password_reset", error);
  }

  logger.info("Password reset email sent");
};

export const sendPasswordResetGoogleNoticeEmail = async (options: {
  email: string;
  name: string;
}): Promise<void> => {
  const loginUrl = buildActionUrl("/auth/login").toString();

  const delivery = resolveEmailDelivery({
    kind: "password_reset_google_notice",
    to: options.email,
    actionUrl: loginUrl,
  });

  if (!delivery) {
    return;
  }

  const transporter = buildResendSmtpTransport(delivery.apiKey);

  try {
    await transporter.sendMail({
      from: delivery.from,
      to: options.email,
      subject: "Akun Lombakita Anda masuk dengan Google",
      text: [
        `Halo ${options.name},`,
        "",
        "Kami menerima permintaan atur ulang password untuk akun Lombakita ini, tetapi akun ini masuk dengan Google dan tidak memiliki password.",
        "Untuk masuk, buka halaman masuk lalu pilih 'Lanjut dengan Google':",
        loginUrl,
        "",
        "Jika Anda tidak memintanya, abaikan email ini.",
      ].join("\n"),
      html: renderEmailHtml({
        heading: "Akun Lombakita Anda masuk dengan Google",
        name: options.name,
        paragraphs: [
          "Kami menerima permintaan atur ulang password untuk akun Lombakita ini, tetapi akun ini masuk dengan Google dan tidak memiliki password. Untuk masuk, buka halaman masuk lalu pilih 'Lanjut dengan Google':",
        ],
        buttonLabel: "Buka Halaman Masuk",
        actionUrl: loginUrl,
        showPlainLink: false,
        footer: "Jika Anda tidak memintanya, abaikan email ini.",
      }),
    });
  } catch (error: unknown) {
    rethrowSmtpSendFailure("password_reset_google_notice", error);
  }

  logger.info("Password reset Google notice email sent");
};

export const sendPasswordChangedEmail = async (options: {
  email: string;
  name: string;
}): Promise<void> => {
  const forgotPasswordUrl = buildActionUrl("/auth/forgot-password").toString();

  const delivery = resolveEmailDelivery({
    kind: "password_changed",
    to: options.email,
    actionUrl: forgotPasswordUrl,
  });

  if (!delivery) {
    return;
  }

  const transporter = buildResendSmtpTransport(delivery.apiKey);

  try {
    await transporter.sendMail({
      from: delivery.from,
      to: options.email,
      subject: "Password Lombakita Anda berubah",
      text: [
        `Halo ${options.name},`,
        "",
        "Password akun Lombakita Anda baru saja diubah. Semua perangkat yang sedang masuk telah dikeluarkan.",
        `Jika ini bukan Anda, atur ulang password sekarang lewat ${forgotPasswordUrl} atau hubungi ${COMPANY.supportEmail}.`,
      ].join("\n"),
      html: renderEmailHtml({
        heading: "Password Lombakita Anda berubah",
        name: options.name,
        paragraphs: [
          "Password akun Lombakita Anda baru saja diubah. Semua perangkat yang sedang masuk telah dikeluarkan.",
          `Jika ini bukan Anda, atur ulang password sekarang lewat ${forgotPasswordUrl} atau hubungi ${COMPANY.supportEmail}.`,
        ],
        buttonLabel: "Atur Ulang Password",
        actionUrl: forgotPasswordUrl,
        showPlainLink: false,
        footer: null,
      }),
    });
  } catch (error: unknown) {
    rethrowSmtpSendFailure("password_changed", error);
  }

  logger.info("Password changed email sent");
};
