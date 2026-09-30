import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { DEIDENTIFIED_EMAIL_DOMAIN } from "@/server/accounts/deidentified-identity";
import { assertRecipientIsRoutable } from "@/server/email/reserved-recipients";

assertServerOnly("server/email/delivery");

export type EmailDelivery = {
  apiKey: string;
  from: string;
};

/**
 * The domain of an address, lowercased, or an empty string when there is no `@` in it.
 *
 * Local rather than shared because `reservedRecipientSuffixOf` answers a different question — it
 * returns whichever reservation matched, so it reports `invalid` for a `deleted.invalid` address
 * and cannot say whether the domain is exactly the tombstone one.
 */
const recipientDomainOf = (address: string): string => {
  const at = address.lastIndexOf("@");
  return at === -1
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
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

  // THE LAST THING BEFORE A USABLE CREDENTIAL, which is what makes it fire if and only if a send
  // would otherwise happen — in whatever process, once per message. Above the suppression branch it
  // would also refuse in processes that were never going to send, which is not the incident: there
  // the worker had delivery ENABLED, and a check here reaches the recipient and stops it.
  //
  // Below the branch, delivery being off means the address is suppressed and logged like any other,
  // so a local signup still completes from the console. It throws rather than returning null
  // because null means "suppressed, carry on", and where a send WAS about to happen an address that
  // can only hard bounce is not something to carry on from.
  //
  // It guards the return rather than the entry, so the structural property is unchanged: this call
  // is the only source of the API key, and a send site that skips it has nothing to send with.
  //
  // A de-identified account's address is suppressed rather than refused, and the difference is the
  // whole of why this branch exists above the check instead of inside it. The check THROWS, which
  // would fail whatever the sender was doing — an organiser publishing results, a request for
  // documents — over a recipient who no longer exists. Skipping is the honest outcome: the action
  // the other person took still succeeds, and nothing is sent. Every other reserved domain still
  // reaches the check and throws as before.
  if (recipientDomainOf(context.to) === DEIDENTIFIED_EMAIL_DOMAIN) {
    logger.info("email.recipient_deidentified", { kind: context.kind });

    return null;
  }

  assertRecipientIsRoutable(context.to, context.kind);

  return { apiKey: serverEnv.resendApiKey, from: serverEnv.authEmailFrom };
};
