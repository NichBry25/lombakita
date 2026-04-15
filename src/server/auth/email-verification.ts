import nodemailer from "nodemailer";
import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/email-verification");

const fallbackEmailFrom = "auth@localhost.invalid";

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

const buildVerificationUrl = (rawToken: string): string => {
  const baseUrl = resolveBaseUrl();
  const url = new URL("/auth/verify-email", baseUrl);
  url.searchParams.set("token", rawToken);

  return url.toString();
};

const buildTransport = () => {
  return nodemailer.createTransport({
    host: "smtp.resend.com",
    port: 587,
    auth: {
      user: "resend",
      pass: serverEnv.resendApiKey ?? "missing-resend-api-key",
    },
  });
};

export const sendRegistrationVerificationEmail = async (options: {
  email: string;
  name: string;
  rawToken: string;
}): Promise<void> => {
  const verificationUrl = buildVerificationUrl(options.rawToken);
  const emailFrom = serverEnv.authEmailFrom ?? fallbackEmailFrom;

  if (!serverEnv.resendApiKey || !serverEnv.authEmailFrom) {
    throw new Error("Resend verification email provider is not fully configured");
  }

  const transporter = buildTransport();

  await transporter.sendMail({
    from: emailFrom,
    to: options.email,
    subject: "Verifikasi akun Lombakita",
    text: [
      `Halo ${options.name},`,
      "",
      "Terima kasih sudah mendaftar di Lombakita.",
      "Klik tautan berikut untuk memverifikasi email Anda:",
      verificationUrl,
      "",
      "Tautan ini berlaku selama 24 jam.",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #0f1012;">
        <h2 style="margin-bottom: 12px;">Verifikasi akun Lombakita</h2>
        <p style="margin: 0 0 12px;">Halo ${options.name},</p>
        <p style="margin: 0 0 16px;">
          Terima kasih sudah mendaftar di Lombakita. Klik tombol di bawah untuk memverifikasi email Anda.
        </p>
        <p style="margin: 0 0 16px;">
          <a href="${verificationUrl}" style="background: #355795; color: #f4f8ff; text-decoration: none; padding: 10px 16px; border-radius: 8px; display: inline-block;">
            Verifikasi Email
          </a>
        </p>
        <p style="margin: 0 0 10px;">Atau gunakan tautan ini:</p>
        <p style="word-break: break-all; margin: 0 0 12px;">
          <a href="${verificationUrl}">${verificationUrl}</a>
        </p>
        <p style="margin: 0; color: #4a5565;">Tautan ini berlaku selama 24 jam.</p>
      </div>
    `,
  });

  logger.info("Registration verification email sent", {
    email: options.email,
  });
};
