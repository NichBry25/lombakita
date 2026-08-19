// How a bukti transfer's own state is NAMED and TONED for the ORGANISER reviewing it.
//
// Client-safe: the only import is a type, erased at compile time.
//
// Deliberately separate from `payment-display.ts`, which describes the same rows to the candidate.
// The two never merge, because the same row means different things to the two people looking at it.
// A proof sitting in `pending_review` is, to the payer, a thing to wait on — "Menunggu verifikasi",
// neutral. To the organiser it is a thing to do. Rendering the payer's wording and the payer's
// neutral tone in the reviewer's queue would describe the reviewer's own inbox from the point of
// view of someone waiting on them.

import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";
import type { StatusBadgeTone } from "@/lib/ui/status-badge-tone";

// Single-word values capitalized, multi-word sentence case, per the form and control standards.
export const PROOF_STATUS_LABELS: Record<ManualPaymentProofStatus, string> = {
  pending_review: "Perlu ditinjau",
  verified: "Diverifikasi",
  rejected: "Ditolak",
  voided: "Dibatalkan platform",
};

// Values must be tones `.status-badge` styles; `status-badge-tone.test.ts` enforces it against
// globals.css.
export const PROOF_STATUS_TONES: Record<ManualPaymentProofStatus, StatusBadgeTone> = {
  // Urgent rather than neutral: this is the reviewer's queue, and the row is asking them for a
  // decision. The candidate's view of the identical row is `awaiting` — nothing is being asked of
  // them — and that divergence is the reason this map exists.
  pending_review: "closing",
  verified: "paid",
  rejected: "cancelled",
  // A void is a platform correction, not a verdict on the money. Neutral, because the organiser
  // did not decide it and cannot act on it.
  voided: "closed",
};
