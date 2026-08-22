// The refusal a candidate sees when a priced competition cannot currently take their money.
//
// Its own module, with no server-only imports, so both registration services and the routes that
// render it can reach it without pulling the payment stack in behind it.

export type RegistrationPaymentErrorCode = "registration_payment_unavailable";

/**
 * A priced competition that cannot be charged against right now.
 *
 * ONE CODE FOR THREE CAUSES: the institution is unverified, it has published no bank account, or
 * no platform fee rule is in force. They are the same event from the candidate's side: the
 * organiser is not ready to take money, and nothing the candidate does changes it.
 *
 * `cause` carries the underlying refusal for logs and operator tooling. It is deliberately NOT part
 * of the message: an institution's verification state and its billing configuration are not facts
 * to hand to anyone who clicks register.
 */
export class RegistrationPaymentError extends Error {
  public readonly status = 409;

  constructor(
    public readonly code: RegistrationPaymentErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RegistrationPaymentError";
  }
}
