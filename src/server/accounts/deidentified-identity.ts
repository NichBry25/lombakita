// The tombstone values a de-identified account is rewritten to.
//
// They live in one module because three readers need them and they must agree: the service that
// writes them, the email boundary that refuses to send to the address they produce, and the tests
// that check both. A second spelling of any of these strings would be a second answer to "is this
// account deleted", and the address one is load-bearing — see `resolveEmailDelivery`.

/**
 * The domain every de-identified address sits under.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so an address under it is
 * unsendable by construction rather than by a delivery setting. `src/server/email/reserved-recipients.ts`
 * already refuses it at the send boundary; the de-identification action only makes that the
 * address of every deleted account.
 */
export const DEIDENTIFIED_EMAIL_DOMAIN = "deleted.invalid";

/**
 * The address a de-identified account is rewritten to.
 *
 * It carries the user id so the row stays unique under `users_email_unique` and so an operator
 * reading the table can tell which account the tombstone is. It is not a person's address and
 * nothing may be sent to it.
 */
export const deidentifiedEmail = (userId: string): string =>
  `deleted+${userId}@${DEIDENTIFIED_EMAIL_DOMAIN}`;

/**
 * The username a de-identified account is rewritten to.
 *
 * A hyphen never occurs in a real username — `parseUsername` in
 * `src/server/user-profile/profile-core.ts` allows `[a-z0-9_]` only — so this cannot collide with
 * a live account's name, and it stays unique under `users_username_unique_idx` because the user id
 * is in it.
 */
export const deidentifiedUsername = (userId: string): string => `deleted-${userId}`;

/** What `users.name` becomes. Read by other people, so it is a phrase and not a placeholder. */
export const DEIDENTIFIED_DISPLAY_NAME = "Akun dihapus";

/** What a personal institution's `display_name` becomes. */
export const DEIDENTIFIED_INSTITUTION_NAME = "Institusi dihapus";

/**
 * What a NOT NULL personal text column becomes when the row itself has to survive.
 *
 * The rows are kept because other people's records point at them; the text on them is the deleted
 * person's own, so it is replaced rather than nulled. A reader who sees it knows the value was
 * removed on request.
 */
export const DEIDENTIFIED_TEXT = "[dihapus]";

/** What `users.suspension_reason` becomes — the account's own record of why it is gone. */
export const DEIDENTIFIED_SUSPENSION_REASON = "Akun dihapus atas permintaan pemilik";

/** What a personal institution's `suspension_reason` becomes. */
export const DEIDENTIFIED_INSTITUTION_SUSPENSION_REASON = "Pemilik akun meminta penghapusan data";
