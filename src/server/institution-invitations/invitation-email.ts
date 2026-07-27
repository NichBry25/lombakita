import { Resend } from "resend";
import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-invitations/invitation-email");

const ROLE_LABELS: Record<string, string> = {
  institution_owner: "Pemilik institusi",
  institution_staff: "Staf institusi",
  institution_member: "Anggota institusi",
};

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

// Step 6.5e — acceptance is now in-app (session-id matched), so the email no longer carries a
// token-acceptance link. Two variants:
//   targeted → the recipient already has an account; link them to their inbox to accept/reject.
//   claim    → the recipient has no account yet; link them to the method-first signup with the
//              invite carried as ?invite=<rawToken>. The login page resolves the token server-side
//              to prefill the invited email so claim-at-signup matches. We point DIRECTLY at
//              /auth/login (not /auth/register) so the DEC-0084 redirect cannot drop the param.
const buildInboxUrl = (): string => new URL("/inbox", resolveBaseUrl()).toString();

const buildClaimSignupUrl = (rawToken: string): string => {
  const url = new URL("/auth/login", resolveBaseUrl());
  url.searchParams.set("invite", rawToken);
  return url.toString();
};

const formatExpiryDate = (expiresAt: Date): string => {
  return expiresAt.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

export type InstitutionInvitationEmailMode = "targeted" | "claim";

export const sendInstitutionInvitationEmail = async (options: {
  toEmail: string;
  institutionDisplayName: string;
  invitedRole: string;
  expiresAt: Date;
  mode: InstitutionInvitationEmailMode;
  // Required for `claim` mode (the signup link); ignored for `targeted`.
  rawToken?: string;
}): Promise<void> => {
  if (!serverEnv.resendApiKey || !serverEnv.authEmailFrom) {
    throw new Error("Resend invitation email provider is not fully configured");
  }

  if (options.mode === "claim" && !options.rawToken) {
    throw new Error("claim-mode invitation email requires a rawToken");
  }

  const roleLabel = ROLE_LABELS[options.invitedRole] ?? options.invitedRole;
  const expiryFormatted = formatExpiryDate(options.expiresAt);

  const isClaim = options.mode === "claim";
  const actionUrl = isClaim ? buildClaimSignupUrl(options.rawToken as string) : buildInboxUrl();
  const ctaLabel = isClaim ? "Daftar untuk menerima" : "Buka kotak masuk";
  const leadLine = isClaim
    ? `Buat akun Lombakita dengan email ini untuk menerima undangan sebagai ${roleLabel}.`
    : `Buka kotak masuk Anda di Lombakita untuk menerima atau menolak undangan sebagai ${roleLabel}.`;

  const resend = new Resend(serverEnv.resendApiKey);

  const { error } = await resend.emails.send({
    from: serverEnv.authEmailFrom,
    to: options.toEmail,
    subject: `Undangan bergabung ke ${options.institutionDisplayName} di Lombakita`,
    text: [
      `Anda diundang untuk bergabung ke ${options.institutionDisplayName} sebagai ${roleLabel} di Lombakita.`,
      "",
      leadLine,
      actionUrl,
      "",
      `Undangan ini berlaku hingga ${expiryFormatted}.`,
      "",
      "Jika Anda tidak merasa diundang, abaikan email ini.",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #14453d;">
        <h2 style="margin-bottom: 12px;">Undangan Lombakita</h2>
        <p style="margin: 0 0 12px;">
          Anda diundang untuk bergabung ke <strong>${options.institutionDisplayName}</strong>
          sebagai <strong>${roleLabel}</strong>.
        </p>
        <p style="margin: 0 0 16px;">${leadLine}</p>
        <p style="margin: 0 0 16px;">
          <a href="${actionUrl}" style="background: #c6491b; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 8px; display: inline-block;">
            ${ctaLabel}
          </a>
        </p>
        <p style="margin: 0 0 10px;">Atau gunakan tautan ini:</p>
        <p style="word-break: break-all; margin: 0 0 12px;">
          <a href="${actionUrl}">${actionUrl}</a>
        </p>
        <p style="margin: 0; color: #3d5c56;">Undangan ini berlaku hingga ${expiryFormatted}.</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend email dispatch failed: ${error.message}`);
  }

  logger.info("invitation.email_sent", {
    institutionDisplayName: options.institutionDisplayName,
    invitedRole: options.invitedRole,
    mode: options.mode,
    toEmail: options.toEmail,
  });
};
