/**
 * Classification of a failed outbound email, so a failure that will never succeed is not reported
 * as one that might.
 *
 * Every send site previously collapsed the provider's response into `new Error(message)`. Resend
 * answers with `{ message, statusCode, name }`, so the two facts that decide what an operator
 * should DO — the status and the provider's own code — were discarded at the throw and could not be
 * recovered downstream. A key that is not permitted to send from the configured `from` address
 * answers 403 on every attempt; retrying it burns the retry budget and reports the same shape as a
 * network blip.
 *
 * Three classes, because three things are true at once and each needs a different response:
 *   - `forbidden`          the credential or the sending identity is wrong. Permanent. Fix config.
 *   - `reserved_recipient` the send boundary refused a non-routable address. Permanent, and the
 *                          message never reached the provider, so it costs no reputation.
 *   - `transient`          anything else. A retry is meaningful.
 *
 * NO SENTRY IMPORT HERE, DELIBERATELY. The worker runs `@sentry/node` and the web runtime runs
 * `@sentry/nextjs`; `server/observability/worker-sentry` documents that the latter resolves to its
 * browser build inside a bare Node process and captures nothing while reporting success. A shared
 * module that pulled in either SDK would force one of the two runtimes onto the wrong one, so this
 * file classifies and each runtime reports through the SDK it is allowed to use.
 */

import { ReservedRecipientError } from "@/server/email/reserved-recipients";

export type EmailFailureClass = "forbidden" | "reserved_recipient" | "transient";

/**
 * Resend error codes that mean the credential or the sending identity is wrong.
 *
 * These are the failures a retry cannot fix. `invalid_from_address` and `restricted_api_key` are the
 * pair a send-only key hits when it is asked to send from a domain it is not verified for, which is
 * the production failure this classification exists to make visible.
 */
const FORBIDDEN_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "restricted_api_key",
  "invalid_api_key",
  "missing_api_key",
  "invalid_access",
  "invalid_from_address",
  "security_error",
]);

export type ProviderErrorShape = {
  message: string;
  statusCode: number | null;
  name: string;
};

/**
 * An outbound send that failed, carrying the provider's own verdict rather than a flattened string.
 */
export class EmailSendError extends Error {
  readonly failureClass: EmailFailureClass;
  readonly kind: string;
  readonly providerCode: string;
  readonly statusCode: number | null;

  constructor(options: {
    kind: string;
    failureClass: EmailFailureClass;
    providerCode: string;
    statusCode: number | null;
    message: string;
  }) {
    super(
      `Resend "${options.kind}" send failed (${options.failureClass}, ` +
        `code ${options.providerCode}, status ${options.statusCode ?? "none"}): ${options.message}`,
    );
    this.name = "EmailSendError";
    this.failureClass = options.failureClass;
    this.kind = options.kind;
    this.providerCode = options.providerCode;
    this.statusCode = options.statusCode;
  }
}

/** Whether the provider's response describes a permanent credential or identity failure. */
export const classifyProviderError = (error: ProviderErrorShape): EmailFailureClass =>
  error.statusCode === 403 || FORBIDDEN_PROVIDER_CODES.has(error.name) ? "forbidden" : "transient";

/**
 * The class of any error thrown along a send path, whatever threw it.
 *
 * Used by the reporting sites, which see `unknown` from a catch and cannot assume which of the
 * three sources produced it.
 */
export const classifyEmailFailure = (error: unknown): EmailFailureClass => {
  if (error instanceof ReservedRecipientError) return "reserved_recipient";
  if (error instanceof EmailSendError) return error.failureClass;
  return "transient";
};

/**
 * The class of a failure that CAME FROM a send, or undefined when the failure was something else.
 *
 * `classifyEmailFailure` answers `transient` for every input it does not recognise, which is right
 * for a send site — the send failed and a retry is meaningful — and wrong for a caller deciding
 * whether an email was involved at all. A job that timed out against Postgres is not a transient
 * email failure, and labelling it one puts an `emailFailureClass` on records that have no send in
 * them.
 */
export const emailFailureClassOf = (error: unknown): EmailFailureClass | undefined => {
  if (error instanceof ReservedRecipientError || error instanceof EmailSendError) {
    return classifyEmailFailure(error);
  }

  return undefined;
};

/**
 * Whether a failure is positively an authorization refusal, as opposed to merely permanent.
 *
 * The distinction matters wherever the failure is rendered as a claim about configuration. On the
 * HTTP path `forbidden` is only ever reached through a 403 or a named credential code, so it is
 * already positive evidence. On the SMTP path it is also reached from any 5xx reply, and RFC 5321
 * 5xx covers a refused recipient and an oversized message as well as a rejected identity — so a
 * bare 5xx says the attempt will never succeed, not why.
 */
export const isAuthorizationRefusal = (
  providerCode: string | null,
  statusCode: number | null,
): boolean => {
  if (statusCode === 403) return true;
  if (providerCode === null) return false;

  // Nodemailer's code for a credential the SMTP server rejected outright.
  return providerCode === "EAUTH" || FORBIDDEN_PROVIDER_CODES.has(providerCode);
};

/**
 * Raises the provider's failure with its verdict intact.
 *
 * Every send site calls this instead of building an `Error` from the message alone, which is what
 * keeps `statusCode` and the provider code reachable at the point somebody has to act on them.
 */
export const throwEmailSendFailure = (kind: string, error: ProviderErrorShape): never => {
  throw new EmailSendError({
    kind,
    failureClass: classifyProviderError(error),
    providerCode: error.name,
    statusCode: error.statusCode,
    message: error.message,
  });
};

/**
 * The registration verification email is the one send that does not use the Resend HTTP API.
 *
 * `server/auth/email-verification` posts it through Resend's SMTP endpoint with nodemailer, so its
 * failure arrives as a thrown SMTP error rather than a returned `{ error }`, and none of the codes
 * above apply. RFC 5321 already draws the line this classification needs: a 5xx reply is permanent
 * and a 4xx reply is temporary. An unverified sending identity is refused with 5xx, which is the
 * case that has to be distinguishable here.
 */
type SmtpErrorShape = {
  code?: unknown;
  responseCode?: unknown;
  message?: unknown;
};

export const classifySmtpError = (error: unknown): EmailFailureClass => {
  if (error === null || typeof error !== "object") return "transient";

  const { code, responseCode } = error as SmtpErrorShape;

  // Nodemailer reports a rejected credential as EAUTH regardless of the reply code.
  if (code === "EAUTH") return "forbidden";
  if (typeof responseCode === "number" && responseCode >= 500 && responseCode < 600) {
    return "forbidden";
  }

  return "transient";
};

/** Re-raises a thrown SMTP failure with its reply code preserved. */
export const rethrowSmtpSendFailure = (kind: string, error: unknown): never => {
  const { code, responseCode } = (
    error !== null && typeof error === "object" ? error : {}
  ) as SmtpErrorShape;

  throw new EmailSendError({
    kind,
    failureClass: classifySmtpError(error),
    providerCode: typeof code === "string" ? code : "smtp_error",
    statusCode: typeof responseCode === "number" ? responseCode : null,
    message: error instanceof Error ? error.message : String(error),
  });
};

/**
 * The structured-log payload for a failed send, identical in both runtimes.
 *
 * Deliberately excludes the recipient address: these payloads reach Sentry and the log drain, and
 * the class plus the kind is what an operator acts on.
 */
export const describeEmailFailure = (
  error: unknown,
): {
  failureClass: EmailFailureClass;
  providerCode: string | null;
  statusCode: number | null;
  detail: string;
} => {
  const failureClass = classifyEmailFailure(error);

  if (error instanceof EmailSendError) {
    return {
      failureClass,
      providerCode: error.providerCode,
      statusCode: error.statusCode,
      detail: error.message,
    };
  }

  return {
    failureClass,
    providerCode: null,
    statusCode: null,
    detail: error instanceof Error ? error.message : String(error),
  };
};
