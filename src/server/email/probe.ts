import { Resend } from "resend";
import { serverEnv } from "@/config/env.server";

export const isResendConfigured = (): boolean => {
  return Boolean(serverEnv.resendApiKey);
};

// Lightweight API-key validity check — lists domains rather than sending an email.
// "restricted_api_key" means Resend authenticated the key but rejected this specific action
// because the key is scoped to sending only — that still proves the key is valid and
// recognized, so it is treated as a pass. "invalid_api_key" / "missing_api_key" and any other
// error are treated as a failure.
//
// WHAT THIS PROVES, AND WHAT IT CANNOT. Both live keys are restricted send-only, so
// `domains.list()` answers `restricted_api_key` on every call and this probe's only real
// assertion is that a key exists and Resend authenticates it.
//
// It CANNOT see the failure that actually matters: a key that is not permitted to send from the
// configured AUTH_EMAIL_FROM answers 403 at send time and `restricted_api_key` here, so this
// reports `resend: ok` in exactly the broken configuration. That is the shape Rule 31 names after
// probeMeilisearch reported healthy for weeks against a dead key.
//
// The operation the app actually performs is a send, and the honest probe is a send to a Resend
// simulator address from the configured AUTH_EMAIL_FROM — which would 403 precisely when
// production would. That is deliberately NOT wired here yet: it can only be turned on once the
// sending subdomain is verified, because before then it would fail the deploy gate for the very
// reason the gate is being taught to detect.
export const probeResend = async (): Promise<void> => {
  if (!serverEnv.resendApiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const resend = new Resend(serverEnv.resendApiKey);
  const { error } = await resend.domains.list();

  if (error && error.name !== "restricted_api_key") {
    throw new Error(`Resend API key check failed: ${error.message}`);
  }
};
