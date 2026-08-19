import { describe, expect, it } from "vitest";
import {
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONES,
  derivePaymentDisplayStatus,
  formatRupiah,
  type PaymentDisplayStatus,
} from "@/lib/finance/payment-display";

const withProof = (
  status: "pending_review" | "verified" | "rejected" | "voided",
  resubmissionAllowed = true,
) => ({ status: "pending" as const, proof: { status, resubmissionAllowed } });

describe("derivePaymentDisplayStatus", () => {
  it("says nothing has been sent when there is no proof", () => {
    expect(derivePaymentDisplayStatus({ status: "pending", proof: null })).toBe(
      "awaiting_transfer",
    );
  });

  it("separates a rejection the organiser left open from one they barred", () => {
    // The whole reason this function exists. Both are ledger-`pending` and both have a `rejected`
    // proof, but one is a candidate who can act and one is a candidate who cannot — and telling
    // the second to "unggah bukti yang baru" would send them somewhere the server refuses.
    expect(derivePaymentDisplayStatus(withProof("rejected", true))).toBe("rejected_resubmittable");
    expect(derivePaymentDisplayStatus(withProof("rejected", false))).toBe("rejected_final");
  });

  it("reads a void as nothing sent, which is what a void leaves behind", () => {
    // A void closes an attempt without ruling on the money and the payer may always refile after
    // one, so the honest description of the resulting state is the same as never having sent.
    expect(derivePaymentDisplayStatus(withProof("voided", false))).toBe("awaiting_transfer");
  });

  it("LETS THE LEDGER WIN over the proof row wherever they disagree", () => {
    // The proof is a claim about the money; the ledger is the record of it. A verified proof
    // against a refunded payment is refunded, and reporting it as paid would tell a candidate
    // they are enrolled in something they have been refunded out of.
    const verifiedProof = { status: "verified" as const, resubmissionAllowed: true };

    expect(derivePaymentDisplayStatus({ status: "refunded", proof: verifiedProof })).toBe(
      "refunded",
    );
    expect(derivePaymentDisplayStatus({ status: "expired", proof: verifiedProof })).toBe("expired");
    expect(derivePaymentDisplayStatus({ status: "succeeded", proof: verifiedProof })).toBe("paid");
  });

  it("reports a verified proof whose ledger has not caught up as awaiting review, not paid", () => {
    // The honest weaker claim during a transient. Saying "Lunas" here would be the platform
    // asserting money arrived on the strength of a row the ledger has not confirmed.
    expect(derivePaymentDisplayStatus(withProof("verified"))).toBe("awaiting_review");
  });

  it("names and tones every display status, so no state can render blank", () => {
    const all: PaymentDisplayStatus[] = [
      "awaiting_transfer",
      "awaiting_review",
      "rejected_resubmittable",
      "rejected_final",
      "paid",
      "expired",
      "refunded",
    ];

    for (const status of all) {
      expect(PAYMENT_STATUS_LABELS[status], `${status} has no label`).toBeTruthy();
      expect(PAYMENT_STATUS_TONES[status], `${status} has no tone`).toBeTruthy();
    }
  });
});

describe("formatRupiah", () => {
  it("renders whole rupiah with the separator Indonesian banking apps use", () => {
    // Pinned because the candidate RETYPES this number into a banking app. `Intl` defaults to two
    // fraction digits, which would render Rp150.000,00 — a figure that does not exist in IDR and
    // that a payer could reasonably enter as 15000000.
    expect(formatRupiah(150_000, "IDR")).toBe("Rp 150.000");
  });

  it("separates the symbol with a NON-BREAKING space", () => {
    // Not cosmetic: a normal space lets the amount wrap away from its currency symbol at narrow
    // widths, leaving a bare "150.000" on its own line on the surface where the figure matters
    // most. Asserted explicitly because the two spaces are indistinguishable by eye in a diff.
    expect(formatRupiah(150_000, "IDR")).toContain(" ");
    expect(formatRupiah(150_000, "IDR")).not.toContain("Rp 150");
  });

  it("does not round a figure into a different amount", () => {
    expect(formatRupiah(1_250_500, "IDR")).toBe("Rp 1.250.500");
    expect(formatRupiah(0, "IDR")).toBe("Rp 0");
  });
});
