/**
 * Resend's simulator mailboxes.
 *
 * These are the opposite of a reserved recipient: they route to the provider ON PURPOSE and produce
 * a known outcome without ever reaching a person. That makes them the only addresses a fixture, a
 * seed or a live probe may hand to the provider when the send itself is the thing being exercised.
 *
 * `delivered@` and `bounced@` ONLY. `complained@resend.dev` is deliberately absent: a complaint is
 * recorded against the sending domain's reputation exactly the way a real one is, which is the harm
 * this whole line of work exists to prevent.
 *
 * Declared in `src/` rather than beside the fixture gate that used to own it, because the connector
 * probe sends from production code and needs the same constant. One definition, imported by both;
 * a second copy would drift from the list the gate enforces.
 */

/** Accepted and delivered by Resend, without reaching a mailbox. Use where a send must succeed. */
export const DELIVERED_SIMULATOR_RECIPIENT = "delivered@resend.dev";

/** Accepted, then hard-bounced by Resend on purpose. Use where a bounce is the behaviour under test. */
export const BOUNCED_SIMULATOR_RECIPIENT = "bounced@resend.dev";

export const SIMULATOR_RECIPIENTS = Object.freeze([
  DELIVERED_SIMULATOR_RECIPIENT,
  BOUNCED_SIMULATOR_RECIPIENT,
] as const);
