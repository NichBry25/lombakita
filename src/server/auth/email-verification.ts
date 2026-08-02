import nodemailer from "nodemailer";
import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { resolveEmailDelivery } from "@/server/email/delivery";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/email-verification");

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

const buildVerificationUrl = (rawToken: string): string => {
  const baseUrl = resolveBaseUrl();
  const url = new URL("/auth/verify-email", baseUrl);
  url.searchParams.set("token", rawToken);

  return url.toString();
};

const buildTransport = (apiKey: string) => {
  return nodemailer.createTransport({
    host: "smtp.resend.com",
    port: 587,
    auth: {
      user: "resend",
      pass: apiKey,
    },
  });
};

export const sendRegistrationVerificationEmail = async (options: {
  email: string;
  name: string;
  rawToken: string;
}): Promise<void> => {
  const verificationUrl = buildVerificationUrl(options.rawToken);

  const delivery = resolveEmailDelivery({
    kind: "registration_verification",
    to: options.email,
    actionUrl: verificationUrl,
  });

  if (!delivery) {
    return;
  }

  const transporter = buildTransport(delivery.apiKey);

  await transporter.sendMail({
    from: delivery.from,
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
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #14453d;">
        <h2 style="margin-bottom: 12px;">Verifikasi akun Lombakita</h2>
        <p style="margin: 0 0 12px;">Halo ${options.name},</p>
        <p style="margin: 0 0 16px;">
          Terima kasih sudah mendaftar di Lombakita. Klik tombol di bawah untuk memverifikasi email Anda.
        </p>
        <p style="margin: 0 0 16px;">
          <a href="${verificationUrl}" style="background: #c6491b; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 8px; display: inline-block;">
            Verifikasi Email
          </a>
        </p>
        <p style="margin: 0 0 10px;">Atau gunakan tautan ini:</p>
        <p style="word-break: break-all; margin: 0 0 12px;">
          <a href="${verificationUrl}">${verificationUrl}</a>
        </p>
        <p style="margin: 0; color: #3d5c56;">Tautan ini berlaku selama 24 jam.</p>
      </div>
    `,
  });

  logger.info("Registration verification email sent", {
    email: options.email,
  });
};
