/**
 * Liveness probe for outbound email.
 *
 * IT SENDS. The previous probe listed domains, which a send-only key answers with
 * `restricted_api_key` whatever else is wrong, so it reported `resend: ok` in exactly the broken
 * configuration it existed to catch. That is the shape Rule 31 names after `probeMeilisearch`
 * reported healthy for weeks against a dead key. Production carried a sending identity its own API
 * key refused, on every worker send, for weeks, while this file said ok.
 *
 * WHAT IT ASSERTS: that the configured `AUTH_EMAIL_FROM` is AUTHORIZED for the configured
 * `RESEND_API_KEY`. Nothing else. It performs the operation the application performs, a send,
 * addressed to a Resend simulator mailbox, so the assertion costs no reputation and reaches no
 * person.
 *
 * WHAT IT MUST NEVER CLAIM: that a sending domain is verified. A key not scoped to a verified
 * domain and a domain that was never verified produce a byte-identical refusal, so the two are
 * indistinguishable from here and reporting either one as the cause would be an invention.
 *
 * BOTH TRANSPORTS, because the application uses both: sixteen sends go over the Resend HTTP API and
 * the registration verification email goes over Resend's SMTP endpoint. They share one resolution
 * boundary, so a sender is authorized for both or neither in every case measured so far. That is an
 * observation about today's provider and not a guarantee, and a probe that checked one transport
 * and reported for both would be asserting something it had not measured.
 *
 * Each function below resolves its own delivery, exactly as every production send site does. That
 * is what puts them inside the send-site census in `send-sites.test.ts`, which is the instrument
 * that proves a recipient reached the guard before the message left.
 */

import { Resend } from "resend";
import { serverEnv } from "@/config/env.server";
import { resolveEmailDelivery } from "@/server/email/delivery";
import {
  describeEmailFailure,
  isAuthorizationRefusal,
  rethrowSmtpSendFailure,
  throwEmailSendFailure,
} from "@/server/email/send-failure";
import { DELIVERED_SIMULATOR_RECIPIENT } from "@/server/email/simulator-recipients";
import { buildResendSmtpTransport } from "@/server/email/smtp-transport";

/**
 * The sender is checked as well as the key, because the sender is half of what is being asserted.
 * Absent, it is a missing configuration rather than a live failure, and the gate should say so.
 */
export const isResendConfigured = (): boolean => {
  return Boolean(serverEnv.resendApiKey && serverEnv.authEmailFrom);
};

const PROBE_SUBJECT = "Lombakita connector probe";

const PROBE_BODY = [
  "Automated sender-authorization probe from the Lombakita deploy gate.",
  "Addressed to a Resend simulator mailbox. No action is required and nobody receives this.",
].join("\n");

/**
 * Delivery suppressed means the probe cannot send, and a probe that cannot run its assertion must
 * refuse rather than pass. Deployed environments always deliver, so this fires only locally.
 *
 * The wording carries the whole explanation because the reader is a developer seeing a red line on
 * their own machine. A message that only says the check failed teaches them to ignore this line,
 * and an ignored line is worth less than no line at all.
 */
class DeliverySuppressedError extends Error {}

const deliverySuppressed = (): Error =>
  new DeliverySuppressedError(
    "not measured. Email delivery is suppressed outside deployed environments, so there is no " +
      "send to check a sender against. This is expected on a local machine and is not a broken " +
      "connector. Sender authorization is checked in preview and production, where delivery is " +
      "always on.",
  );

const sendProbeOverHttp = async (): Promise<void> => {
  const delivery = resolveEmailDelivery({
    kind: "connector_probe_http",
    to: DELIVERED_SIMULATOR_RECIPIENT,
  });

  if (!delivery) {
    throw deliverySuppressed();
  }

  const resend = new Resend(delivery.apiKey);

  const { error } = await resend.emails.send({
    from: delivery.from,
    to: DELIVERED_SIMULATOR_RECIPIENT,
    subject: PROBE_SUBJECT,
    text: PROBE_BODY,
  });

  if (error) {
    throwEmailSendFailure("connector_probe_http", error);
  }
};

const sendProbeOverSmtp = async (): Promise<void> => {
  const delivery = resolveEmailDelivery({
    kind: "connector_probe_smtp",
    to: DELIVERED_SIMULATOR_RECIPIENT,
  });

  if (!delivery) {
    throw deliverySuppressed();
  }

  const transporter = buildResendSmtpTransport(delivery.apiKey);

  try {
    await transporter.sendMail({
      from: delivery.from,
      to: DELIVERED_SIMULATOR_RECIPIENT,
      subject: PROBE_SUBJECT,
      text: PROBE_BODY,
    });
  } catch (error: unknown) {
    rethrowSmtpSendFailure("connector_probe_smtp", error);
  }
};

/**
 * The operator-facing reason, which has to separate the three things a failed send can mean.
 *
 * A retryable failure is not a verdict at all, and saying "not authorized" there would report a
 * network blip as a misconfigured identity.
 *
 * A permanent failure is not automatically an authorization one either. The SMTP classifier reaches
 * `forbidden` from any 5xx reply, and 5xx also covers a refused recipient and an oversized message,
 * so a bare 5xx establishes that the attempt will never succeed without establishing why. Naming
 * the key there would send an operator to rotate a credential that was never the problem, so the
 * claim is only made on the evidence that supports it.
 */
const describeProbeFailure = (transport: string, error: unknown): string => {
  const sender = serverEnv.authEmailFrom ?? "(unset)";
  const { failureClass, providerCode, statusCode, detail } = describeEmailFailure(error);
  const codes = `(code ${providerCode ?? "none"}, status ${statusCode ?? "none"})`;

  if (failureClass !== "forbidden") {
    return (
      `sender "${sender}" could not be proven authorized over ${transport}: the attempt failed ` +
      `for an unrelated reason (${failureClass}). ${detail}`
    );
  }

  if (!isAuthorizationRefusal(providerCode, statusCode)) {
    return (
      `sender "${sender}" could not be proven authorized over ${transport}: the send was refused ` +
      `permanently ${codes}, but the reply does not say the credential or the sending identity ` +
      "was the reason. Read the detail before changing any key. " +
      detail
    );
  }

  return (
    `sender "${sender}" is NOT AUTHORIZED for the configured RESEND_API_KEY over ${transport} ` +
    `${codes}. This does not say whether the domain is verified: a key not scoped to a verified ` +
    `domain and a domain that was never verified are refused identically. ${detail}`
  );
};

const probeTransport = async (transport: string, send: () => Promise<void>): Promise<void> => {
  try {
    await send();
  } catch (error: unknown) {
    // A suppression refusal already explains itself and is not a failed send, so it travels
    // unchanged. Wrapping it produced "the attempt failed for an unrelated reason (transient)" in
    // front of the explanation, which is the reading this message exists to prevent.
    if (error instanceof DeliverySuppressedError) {
      throw error;
    }

    throw new Error(describeProbeFailure(transport, error));
  }
};

/**
 * Sequential rather than parallel: the first failure is the one an operator acts on, and a sender
 * the key refuses is refused identically on both transports, so continuing would send a second
 * doomed message to learn nothing. On the passing path both are exercised.
 */
export const probeResend = async (): Promise<void> => {
  await probeTransport("http", sendProbeOverHttp);
  await probeTransport("smtp", sendProbeOverSmtp);
};
