import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { resolveEmailDelivery } from "@/server/email/delivery";
import { rethrowSmtpSendFailure } from "@/server/email/send-failure";
import { buildResendSmtpTransport } from "@/server/email/smtp-transport";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/email-verification");

export const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

export const sendRegistrationVerificationEmail = async (options: {
  email: string;
  code: string;
}): Promise<void> => {
  const delivery = resolveEmailDelivery({
    kind: "registration_verification",
    to: options.email,
  });

  if (!delivery) {
    if (!serverEnv.emailDeliveryEnabled) {
      // Only where delivery is switched off (local and test), so a local sign-up can be finished
      // without an inbox.
      logger.info("auth.registration_code.delivery_suppressed", {
        email: options.email,
        code: options.code,
      });
    }
    return;
  }

  const transporter = buildResendSmtpTransport(delivery.apiKey);

  // The recipient stays inline at the send call rather than hoisted into a variable: the send-site
  // census resolves the address argument off the call expression, and a hoisted object hides it.
  try {
    await transporter.sendMail({
      from: delivery.from,
      to: options.email,
      subject: "Kode verifikasi akun Lombakita",
      text: [
        "Halo,",
        "",
        "Kode verifikasi akun Lombakita Anda:",
        options.code,
        "",
        "Kode ini berlaku 10 menit. Masukkan kode ini di halaman tempat Anda mendaftar atau masuk.",
        "",
        "Jika Anda tidak meminta kode ini, abaikan email ini.",
      ].join("\n"),
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #14453d;">
          <h2 style="margin-bottom: 12px;">Verifikasi akun Lombakita</h2>
          <p style="margin: 0 0 12px;">Halo,</p>
          <p style="margin: 0 0 12px;">Kode verifikasi akun Lombakita Anda:</p>
          <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 0 0 16px;">${options.code}</p>
          <p style="margin: 0 0 12px;">Kode ini berlaku 10 menit. Masukkan kode ini di halaman tempat Anda mendaftar atau masuk.</p>
          <p style="margin: 0; color: #3d5c56;">Jika Anda tidak meminta kode ini, abaikan email ini.</p>
        </div>
      `,
    });
  } catch (error: unknown) {
    // Nodemailer throws rather than returning a provider error, so the SMTP reply code is the only
    // thing that separates a rejected sending identity from a temporary failure.
    rethrowSmtpSendFailure("registration_verification", error);
  }

  logger.info("Registration verification email sent", {
    email: options.email,
  });
};
