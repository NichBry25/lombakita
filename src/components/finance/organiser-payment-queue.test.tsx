// @vitest-environment jsdom
//
// WHAT THIS SURFACE WITHHOLDS, which is the half a screenshot cannot show.
//
// The browser assertions in `scripts/testing/ui-states.mjs` cover the seeded queue, and that queue
// is deliberately MIXED: a pending proof sits beside a settled one, so "Verifikasi" is legitimately
// on the page and no absent-assertion can be made there. This file supplies the state the seed has
// no competition for (a queue containing only settled proofs) which is the only place the
// withholding is observable.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The router only, and deliberately nothing else. A sibling component test in this repo also mocks
// `@/components/ui`; doing that here would replace the very buttons whose presence and absence this
// file exists to assert, leaving it measuring its own stubs.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { OrganiserPaymentQueue, type OrganiserProofView } from "./organiser-payment-queue";

const proof = (overrides: Partial<OrganiserProofView> = {}): OrganiserProofView => ({
  proofId: "proof_1",
  status: "pending_review",
  submittedAt: "2026-08-18T02:00:00.000Z",
  originalFileName: "bukti.jpg",
  fileSizeBytes: 184_320,
  grossAmount: 150_000,
  currency: "IDR",
  dueAt: "2026-08-21T02:00:00.000Z",
  payerDisplayName: "Bela Rahma",
  priorAttempts: 0,
  rejectionReason: null,
  resubmissionAllowed: true,
  ...overrides,
});

const renderQueue = (proofs: OrganiserProofView[]) =>
  render(
    <UIPrimitivesProvider>
      <OrganiserPaymentQueue
        institutionSlug="seed-academy"
        competitionId="comp_1"
        proofs={proofs}
      />
    </UIPrimitivesProvider>,
  );

describe("OrganiserPaymentQueue", () => {
  it("offers both verdicts on a proof awaiting review", () => {
    // The positive. Every absent-assertion below is worthless without it, since they would all pass
    // against a component that rendered no buttons at all.
    renderQueue([proof()]);

    expect(screen.getByRole("button", { name: "Verifikasi" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tolak" })).toBeTruthy();
  });

  it("WITHHOLDS both verdicts on a verified proof", () => {
    // Withheld, not disabled. Reversing a verification writes a compensating ledger event, which is
    // a platform_ops correction. Rendering a greyed-out control here would advertise an action
    // this surface does not own and send the reviewer hunting for the permission to enable it.
    renderQueue([proof({ status: "verified" })]);

    expect(screen.queryByRole("button", { name: "Verifikasi" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tolak" })).toBeNull();
  });

  it("WITHHOLDS both verdicts on a rejected proof", () => {
    // A rejection is reopened by the candidate submitting again, never by the organiser rejecting
    // it a second time.
    renderQueue([proof({ status: "rejected", rejectionReason: "Nominal tidak sesuai" })]);

    expect(screen.queryByRole("button", { name: "Verifikasi" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tolak" })).toBeNull();
  });

  it("WITHHOLDS both verdicts on a proof the platform voided", () => {
    renderQueue([proof({ status: "voided" })]);

    expect(screen.queryByRole("button", { name: "Verifikasi" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tolak" })).toBeNull();
  });

  it("keeps the file open control on every state, including the settled ones", () => {
    // Reviewing is not the only reason to look. A dispute months later is answered by the receipt,
    // and an organiser who can no longer open it cannot answer it.
    renderQueue([proof({ status: "verified" })]);

    expect(screen.getByRole("button", { name: "Lihat bukti" })).toBeTruthy();
  });

  it("offers verdicts on the pending row only when a settled row sits beside it", () => {
    // The mixed queue, which is what the seeded page actually shows. One pair of controls, not two.
    renderQueue([
      proof({ proofId: "p_pending", status: "pending_review", payerDisplayName: "Bela Rahma" }),
      proof({ proofId: "p_verified", status: "verified", payerDisplayName: "Dewi Anggraini" }),
    ]);

    expect(screen.getAllByRole("button", { name: "Verifikasi" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Lihat bukti" })).toHaveLength(2);
  });

  it("tells the reviewer a rejected payer may still try again, or may not", () => {
    // The organiser's own earlier decision, read back to them. Whether the payer is stranded is not
    // recoverable from the status alone, and it decides whether this row needs anything further.
    const { unmount } = renderQueue([
      proof({
        status: "rejected",
        rejectionReason: "Nominal tidak sesuai",
        resubmissionAllowed: true,
      }),
    ]);
    expect(screen.getByText(/masih dapat mengirim bukti baru/)).toBeTruthy();
    unmount();

    renderQueue([
      proof({
        status: "rejected",
        rejectionReason: "Bukan transfer ke kami",
        resubmissionAllowed: false,
      }),
    ]);
    expect(screen.getByText(/tidak dapat mengirim ulang/)).toBeTruthy();
  });

  it("says the queue is empty rather than rendering an empty list", () => {
    renderQueue([]);

    expect(screen.getByText("Belum ada bukti transfer")).toBeTruthy();
  });
});

// THE CUSTODY INSTRUCTION, WHERE THE DECISION IS ACTUALLY MADE.
//
// It used to stand as a banner on the page, which `ui-states` could read at rest. It now lives in
// the confirmation the reviewer has to pass through, so no page-text harness can see it and this is
// the only thing asserting it survives at all. It is the one sentence that stops an organiser
// verifying on the strength of a screenshot: the platform never sees this money and cannot check.
describe("what the verify confirmation tells the reviewer", () => {
  it("says the money must be visible in the institution's own account first", () => {
    renderQueue([proof()]);
    fireEvent.click(screen.getByRole("button", { name: "Verifikasi" }));

    expect(screen.getByText(/mutasi rekening lembaga Anda/)).toBeTruthy();
    expect(screen.getByText(/Lombakita tidak dapat memeriksanya/)).toBeTruthy();
  });

  it("says the verdict cannot be undone by the organiser who made it", () => {
    renderQueue([proof()]);
    fireEvent.click(screen.getByRole("button", { name: "Verifikasi" }));

    expect(screen.getByText(/tidak dapat Anda batalkan sendiri/)).toBeTruthy();
  });
});

// WHAT COLOUR THE NOTES ARE, which no other check in this repo can see.
//
// The contrast audit measures whether a pairing is legible, never whether it means the right thing.
// Both notes below cleared it in both themes while saying the opposite of the truth: the rejection
// rendered in `info`, which shares its hue with `success` and so reads as a verified payment, and
// the neutral count of prior attempts rendered in `warning`. Nothing but this file fails when they
// swap back.
describe("what tone the queue notes carry", () => {
  const toneOf = (text: RegExp): string | null => {
    const note = screen.getByText(text).closest(".feedback");
    return note ? note.getAttribute("data-tone") : null;
  };

  it("prints a rejection in the refusing tone, never the one success uses", () => {
    renderQueue([
      proof({
        status: "rejected",
        rejectionReason: "Nominal tidak sesuai",
        resubmissionAllowed: true,
      }),
    ]);

    expect(toneOf(/Ditolak dengan alasan/)).toBe("error");
  });

  it("prints the count of prior attempts as a neutral fact, not as a warning", () => {
    renderQueue([proof({ priorAttempts: 2 })]);

    expect(toneOf(/bukti sebelumnya sudah ditinjau/)).toBe("neutral");
  });
});
