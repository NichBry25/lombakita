import { Resend } from "resend";
import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { resolveEmailDelivery } from "@/server/email/delivery";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-email");

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

// Mirrors institution-invitations/invitation-email.ts. Acceptance is in-app
// (session-id matched), so the email links to the inbox (targeted) or to the method-first signup
// carrying ?invite=<rawToken> (claim). Direct /auth/login link avoids the DEC-0084 param-drop.
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

export type TeamInvitationEmailMode = "targeted" | "claim";

export const sendTeamInvitationEmail = async (options: {
  toEmail: string;
  teamName: string;
  competitionTitle: string;
  inviterDisplayName: string | null;
  expiresAt: Date;
  mode: TeamInvitationEmailMode;
  // Required for `claim` mode (the signup link); ignored for `targeted`.
  rawToken?: string;
}): Promise<void> => {
  if (options.mode === "claim" && !options.rawToken) {
    throw new Error("claim-mode team invitation email requires a rawToken");
  }

  const expiryFormatted = formatExpiryDate(options.expiresAt);
  const inviterLabel = options.inviterDisplayName ?? "Kapten tim";

  const isClaim = options.mode === "claim";
  const actionUrl = isClaim ? buildClaimSignupUrl(options.rawToken as string) : buildInboxUrl();
  const ctaLabel = isClaim ? "Daftar untuk menerima" : "Buka kotak masuk";
  const leadLine = isClaim
    ? "Buat akun Lombakita dengan email ini untuk menerima atau menolak undangan."
    : "Buka kotak masuk Anda di Lombakita untuk menerima atau menolak undangan.";

  const delivery = resolveEmailDelivery({
    kind: "team_invitation",
    to: options.toEmail,
    actionUrl,
  });

  if (!delivery) {
    return;
  }

  const resend = new Resend(delivery.apiKey);

  const { error } = await resend.emails.send({
    from: delivery.from,
    to: options.toEmail,
    subject: `Undangan tim ${options.teamName} untuk ${options.competitionTitle}`,
    text: [
      `${inviterLabel} mengundang Anda untuk bergabung dengan tim ${options.teamName}`,
      `pada kompetisi ${options.competitionTitle} di Lombakita.`,
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
        <h2 style="margin-bottom: 12px;">Undangan tim Lombakita</h2>
        <p style="margin: 0 0 12px;">
          <strong>${inviterLabel}</strong> mengundang Anda untuk bergabung dengan tim
          <strong>${options.teamName}</strong> pada kompetisi
          <strong>${options.competitionTitle}</strong>.
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
    throw new Error(`Resend team invite email dispatch failed: ${error.message}`);
  }

  logger.info("team_invitation.email_sent", {
    teamName: options.teamName,
    competitionTitle: options.competitionTitle,
    mode: options.mode,
    toEmail: options.toEmail,
  });
};
