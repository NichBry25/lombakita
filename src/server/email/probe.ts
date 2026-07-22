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
