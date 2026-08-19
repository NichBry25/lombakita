/**
 * The `data-status` values `.status-badge` actually styles.
 *
 * A badge whose `data-status` is not in this set still renders — as a bare grey pill with no colour
 * and no dot — so a wrong value produces no error anywhere: not at build, not at runtime, and not
 * in a contrast audit, which measures whatever colours it finds rather than the ones intended. The
 * failure is only visible to someone looking at the one state that carries the wrong value, which
 * is why it survived review and a full local audit pass in the manual payment lane.
 *
 * The near-miss worth naming: `eligible` and `ineligible` read as if they belong here. They are the
 * vocabulary of `.eligibility-status-card` and `.team-eligibility` — different components, same
 * attribute name — and a `.status-badge` carrying either is unstyled.
 *
 * This union is the intended set. `status-badge-tone.test.ts` parses globals.css and asserts the
 * two agree in both directions, so the union cannot drift from the stylesheet it describes.
 */
export type StatusBadgeTone =
  | "open"
  | "closing"
  | "closed"
  | "upcoming"
  | "ongoing"
  | "awaiting"
  | "overdue"
  | "announced"
  | "cancelled"
  | "featured"
  | "paid"
  | "expired"
  | "refunded";

/** The same set at runtime, for assertions that need to enumerate it. */
export const STATUS_BADGE_TONES: readonly StatusBadgeTone[] = [
  "open",
  "closing",
  "closed",
  "upcoming",
  "ongoing",
  "awaiting",
  "overdue",
  "announced",
  "cancelled",
  "featured",
  "paid",
  "expired",
  "refunded",
] as const;
