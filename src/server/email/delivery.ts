import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/email/delivery");

export type EmailDelivery = {
  apiKey: string;
  from: string;
};

// The single boundary every outbound email passes through, mirroring isR2Available() and
// isMeilisearchAvailable() for the other two side-effecting connectors.
//
// It separates two situations the callers previously could not tell apart:
//   - the provider is not configured   → throws, because that is a real misconfiguration
//   - delivery is disabled here        → returns null, and the caller returns without sending
//
// A suppressed send is logged with whatever the recipient would have needed to act on (a
// verification link, an invitation URL), so a local signup flow can be completed from the console
// instead of an inbox.
export const resolveEmailDelivery = (context: {
  kind: string;
  to: string;
  actionUrl?: string;
}): EmailDelivery | null => {
  if (!serverEnv.resendApiKey || !serverEnv.authEmailFrom) {
    throw new Error("Resend email provider is not fully configured");
  }

  if (!serverEnv.emailDeliveryEnabled) {
    logger.info("email.delivery_suppressed", {
      kind: context.kind,
      to: context.to,
      appEnv: serverEnv.appEnv,
      ...(context.actionUrl ? { actionUrl: context.actionUrl } : {}),
    });

    return null;
  }

  return { apiKey: serverEnv.resendApiKey, from: serverEnv.authEmailFrom };
};
