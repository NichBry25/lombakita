// The manual lane's payment deadline: how long a candidate has to send a bukti transfer.
//
// The window is a COMPETITION setting; the deadline it produces is a PER-PAYMENT SNAPSHOT. That
// split is the whole design. An organiser who shortens the window next week must not move a
// deadline already promised to someone who is mid-transfer, so the resolved instant is written
// onto the payment row at creation and never recomputed from the competition again — the same
// reasoning that makes the Step 7.1 fee snapshot structural rather than an optimisation.
//
// Client-safe: pure, no server-only imports, no I/O.

const DAY_MS = 24 * 60 * 60 * 1000;

// What an organiser gets without choosing. Three days spans a weekend, which a one-day default
// would not: an Indonesian bank transfer initiated on a Saturday can take until Monday to clear.
export const DEFAULT_PAYMENT_WINDOW_DAYS = 3;

// A window shorter than a day cannot survive a single non-banking day, so it would expire
// candidates who did nothing wrong. Enforced by a database CHECK as well as here.
export const MIN_PAYMENT_WINDOW_DAYS = 1;

// The upper bound on what an organiser may CONFIGURE. The binding ceiling in practice is
// registration close (see resolvePaymentDueAt) — this only stops a nonsense value being stored on
// a competition whose registration window is still open-ended.
export const MAX_PAYMENT_WINDOW_DAYS = 30;

export const isValidPaymentWindowDays = (value: number): boolean =>
  Number.isInteger(value) &&
  value >= MIN_PAYMENT_WINDOW_DAYS &&
  value <= MAX_PAYMENT_WINDOW_DAYS;

/**
 * The instant a payment started at `startedAt` must be settled by.
 *
 * The configured window is a MAXIMUM, not a promise: a deadline is never allowed to fall after
 * registration closes, because a payment that is still legitimately open after the competition
 * stopped accepting entries is a registration nobody can honour. `registrationEndAt` therefore
 * clamps the result whenever it lands first.
 *
 * A null `registrationEndAt` means no clamp — an open-ended registration window has nothing to
 * clamp against, and MAX_PAYMENT_WINDOW_DAYS is what bounds the configured value in that case.
 *
 * The clamp can produce a deadline in the PAST, or before `startedAt`, when registration has
 * already closed. That is returned truthfully rather than floored to `startedAt`: the caller
 * deciding whether to open a payment at all is the one that should refuse, and silently inventing
 * a few minutes of grace here would hide that it needed to.
 */
export const resolvePaymentDueAt = (
  startedAt: Date,
  windowDays: number,
  registrationEndAt: Date | null,
): Date => {
  const requested = new Date(startedAt.getTime() + windowDays * DAY_MS);

  if (registrationEndAt === null) return requested;

  return registrationEndAt.getTime() < requested.getTime() ? registrationEndAt : requested;
};
