// How a payment's state is NAMED and TONED for a candidate.
//
// Client-safe: the only imports are types, erased at compile time, so this is importable from a
// client component without pulling the database layer into the bundle.
//
// The display state is NOT the folded payment status, and collapsing the two would lose the
// distinction the whole manual lane is built around. `foldPaymentEvents` answers "what does the
// ledger say about the money": pending, succeeded, refunded, expired. A candidate needs a
// different question answered: "what, if anything, do I have to do next". Those diverge exactly
// where it matters. A payment whose ledger status is `pending` reads as four different situations
// to the person who owes the money: nothing sent yet, evidence sent and waiting, evidence refused
// and needing a new one, or refused with no way forward.

import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";
import type { PaymentDerivedStatus } from "@/lib/finance/payment-state";
import type { StatusBadgeTone } from "@/lib/ui/status-badge-tone";

export type PaymentDisplayStatus =
  /** Nothing has been sent. The candidate owes a transfer and a receipt. */
  | "awaiting_transfer"
  /** Evidence is with the organiser. Nothing for the candidate to do but wait. */
  | "awaiting_review"
  /** Refused, and the organiser left the door open. The candidate sends a new receipt. */
  | "rejected_resubmittable"
  /** Refused and barred. Only platform_ops can reopen this; the candidate cannot act. */
  | "rejected_final"
  /** Confirmed received. */
  | "paid"
  /** The deadline passed with nothing in flight. The registration went with it. */
  | "expired"
  /** Money was returned. */
  | "refunded";

export const derivePaymentDisplayStatus = (payment: {
  status: PaymentDerivedStatus;
  proof: { status: ManualPaymentProofStatus; resubmissionAllowed: boolean } | null;
}): PaymentDisplayStatus => {
  // The LEDGER WINS over the proof row wherever they disagree, because the ledger is the record of
  // the money and the proof is a claim about it. A verified proof against a refunded payment is
  // still refunded.
  if (payment.status === "succeeded") return "paid";
  if (payment.status === "refunded") return "refunded";
  if (payment.status === "expired") return "expired";

  if (!payment.proof) return "awaiting_transfer";

  switch (payment.proof.status) {
    case "pending_review":
      return "awaiting_review";
    case "rejected":
      return payment.proof.resubmissionAllowed ? "rejected_resubmittable" : "rejected_final";
    // A void is platform_ops closing an attempt without ruling on the money, and the payer may
    // always refile after one, so it reads as "nothing sent", which is what it leaves behind.
    case "voided":
      return "awaiting_transfer";
    // A verified proof with a ledger that has not folded to succeeded is a transient the candidate
    // should not be shown as paid. Reported as awaiting review, which is the honest weaker claim.
    case "verified":
      return "awaiting_review";
  }
};

// Single-word values capitalized, multi-word sentence case, per the form and control standards.
export const PAYMENT_STATUS_LABELS: Record<PaymentDisplayStatus, string> = {
  awaiting_transfer: "Menunggu pembayaran",
  awaiting_review: "Menunggu verifikasi",
  rejected_resubmittable: "Perlu bukti baru",
  rejected_final: "Ditolak",
  paid: "Lunas",
  expired: "Kedaluwarsa",
  refunded: "Dikembalikan",
};

// Maps onto the shared `.status-badge` vocabulary in globals.css rather than introducing a parallel
// set, so a payment badge reads the same as every other badge in the app.
//
// Every value here must be a `data-status` the stylesheet actually defines. `eligible`/`ineligible`
// look like they belong and do not: they are the vocabulary of `.eligibility-status-card` and
// `.team-eligibility`, and a `.status-badge` carrying one renders with no colour and no dot. The
// contract test parses globals.css and fails on any value the badge does not define, because a
// wrong tone is invisible in review and invisible in a screenshot of any state that does not
// happen to be seeded.
export const PAYMENT_STATUS_TONES: Record<PaymentDisplayStatus, StatusBadgeTone> = {
  awaiting_transfer: "open",
  // Neutral, not "open": nothing is being asked of the candidate while the organiser holds it.
  awaiting_review: "awaiting",
  // Urgent rather than failed: the candidate can still act, and the deadline is still running.
  rejected_resubmittable: "closing",
  rejected_final: "cancelled",
  paid: "paid",
  expired: "expired",
  refunded: "refunded",
};

/**
 * The amount as Indonesian currency.
 *
 * `minimumFractionDigits: 0` because IDR is quoted in whole rupiah and `Intl` would otherwise
 * render `Rp150.000,00`, two decimal places nobody uses, on a figure the candidate has to type
 * into a banking app.
 */
export const formatRupiah = (amount: number, currency: string): string =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);

/**
 * A free-text reason terminated exactly once, so the sentence printed after it reads as a sentence.
 *
 * THE ONLY PLACE A REASON'S PUNCTUATION IS DECIDED. Every surface that shows a rejection or a void
 * follows the reason with a further sentence, and the reason itself is typed by an organiser who
 * may or may not end it with a stop. Left to each call site the two mistakes are opposite, and both
 * shipped: the organiser's queue appended nothing and ran two sentences together, while the
 * candidate's panel appended a stop unconditionally and printed "Bukti tidak terbaca..".
 *
 * Neither was visible in any fixture, because every seeded reason ends in exactly one period.
 */
export const asSentence = (text: string): string => {
  const trimmed = text.trim();

  if (trimmed === "") return trimmed;

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * A finance timestamp spelled out in full: a deadline, but also an accrual date or the moment a
 * rate was acknowledged. Never a relative "3 hari lagi": a transfer needs a real date, and on the
 * fee statement there is no deadline for a relative phrase to be relative TO.
 */
export const formatFinanceDateTime = (isoDate: string): string =>
  new Date(isoDate)
    .toLocaleString("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
    // Intl writes the separator in lower case. Every other word the app shows in a value position
    // is capitalised, so this one is too.
    .replace(" pukul ", " Pukul ");
