// HOW A PAYMENT DEADLINE READS TO THE PERSON IT APPLIES TO.
//
// The instant itself is already on the payment row (DEC-0169: snapshotted at creation, never
// recomputed from the competition's window). What this module adds is the part a bare timestamp
// cannot carry — whether the deadline is still counting, how much time is left, and whether it
// applies to this candidate at all right now.
//
// THE SUSPENSION IS THE REASON THIS EXISTS. A proof sitting in `pending_review` suspends expiry
// indefinitely: the worker re-reads that under a row lock and declines to expire. A candidate in
// that state is NOT at risk, and a deadline rendered as a live countdown next to their pending
// evidence tells them they are — which is both false and the exact thing that makes someone
// re-transfer money they have already sent.
//
// Client-safe: pure, no server-only imports, no I/O. `now` is a parameter so the same function
// serves a render and a test.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Inside this much time, the deadline stops being information and becomes a warning. */
export const DEADLINE_URGENT_WITHIN_MS = DAY_MS;

export type PaymentDeadlineState =
  /** No deadline was ever set on this payment. */
  | { kind: "none" }
  /**
   * Evidence is with the organiser, so the deadline cannot end this registration. Carries the
   * instant anyway: it is still the date the candidate met, and hiding it invites the question of
   * whether they met it.
   */
  | { kind: "suspended"; dueAt: string }
  /**
   * The money is settled — succeeded or refunded — so the deadline has no power left over this
   * registration. Carries the instant for the same reason `suspended` does: it is still the date
   * that was met, and the record of it is worth keeping once the countdown is gone.
   */
  | { kind: "settled"; dueAt: string }
  /** The deadline has passed. Separate from the payment being expired, which is the worker's act. */
  | { kind: "passed"; dueAt: string }
  | { kind: "remaining"; dueAt: string; remainingMs: number; urgent: boolean };

/**
 * What this payment's deadline currently means for its payer.
 *
 * `suspended` outranks everything except a missing deadline, INCLUDING a deadline that has already
 * gone by: a candidate who submitted in time and is waiting on a slow organiser must not be shown
 * "telah lewat" on a deadline that no longer has any power over them.
 *
 * `settled` outranks even that, and for the stronger form of the same reason. A suspension can be
 * lifted and the clock resume; a settled payment is finished, so a countdown beside "pembayaran
 * sudah diverifikasi" states an obligation that does not exist. Both arms exist because a deadline
 * is only ever information about what can still happen to this registration.
 */
export const describePaymentDeadline = (
  dueAt: string | null,
  options: { suspended: boolean; settled?: boolean; now?: Date },
): PaymentDeadlineState => {
  if (dueAt === null) return { kind: "none" };
  if (options.settled) return { kind: "settled", dueAt };
  if (options.suspended) return { kind: "suspended", dueAt };

  const remainingMs = new Date(dueAt).getTime() - (options.now ?? new Date()).getTime();

  if (!Number.isFinite(remainingMs)) return { kind: "none" };
  if (remainingMs <= 0) return { kind: "passed", dueAt };

  return { kind: "remaining", dueAt, remainingMs, urgent: remainingMs <= DEADLINE_URGENT_WITHIN_MS };
};

/**
 * How long is left, in the largest unit that still says something useful.
 *
 * Rounded DOWN, always. "2 hari lagi" on something with 2 days and 23 hours left is safe; rounding
 * that up to 3 days would promise time the candidate does not have.
 */
export const formatTimeRemaining = (remainingMs: number): string => {
  if (remainingMs >= DAY_MS) return `${Math.floor(remainingMs / DAY_MS)} hari lagi`;
  if (remainingMs >= HOUR_MS) return `${Math.floor(remainingMs / HOUR_MS)} jam lagi`;
  if (remainingMs >= MINUTE_MS) return `${Math.floor(remainingMs / MINUTE_MS)} menit lagi`;
  return "kurang dari semenit lagi";
};
