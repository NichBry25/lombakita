/**
 * Resend's SMTP endpoint, which is the transport the registration verification email uses.
 *
 * Extracted so the connector probe exercises THE TRANSPORT THE APP ACTUALLY USES rather than a
 * second copy of its settings. A probe built on its own duplicate would keep reporting on a host
 * and port the application had stopped using, which is the failure mode a probe exists to prevent.
 *
 * Host, port and username are fixed by the provider rather than configured, so they are constants
 * here and carry no deploy-gate spec. Only the API key varies, and it arrives from the same
 * `resolveEmailDelivery` boundary every other send passes through.
 */

import nodemailer from "nodemailer";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/email/smtp-transport");

export const RESEND_SMTP_HOST = "smtp.resend.com";
export const RESEND_SMTP_PORT = 587;
const RESEND_SMTP_USER = "resend";

export const buildResendSmtpTransport = (apiKey: string) => {
  return nodemailer.createTransport({
    host: RESEND_SMTP_HOST,
    port: RESEND_SMTP_PORT,
    auth: {
      user: RESEND_SMTP_USER,
      pass: apiKey,
    },
  });
};
