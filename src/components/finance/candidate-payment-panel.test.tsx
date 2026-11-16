// @vitest-environment jsdom
//
// THE DEADLINE IS NAMED IN EVERY STATE THAT IS STILL RUNNING AGAINST ONE.
//
// A rejection resumes the clock (only `pending_review` suspends it) so both rejection branches
// are racing a deadline. The barred branch is the harshest state on the lane: the candidate cannot
// cancel (a proof exists, so surface 5 withholds it), cannot resubmit (the organiser barred it),
// and will be cancelled automatically when the clock runs out. That combination only became
// reachable once the cancel affordance, the deadline surfacing and the verdict path were all in
// place, so no single surface owned it.
//
// The suspended state is asserted alongside as the counter-case: it must NOT carry deadline
// urgency, because expiry cannot reach that candidate at all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CandidatePaymentPanel, type CandidatePaymentPanelProps } from "./candidate-payment-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const DUE = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

type QrisState = NonNullable<CandidatePaymentPanelProps["payment"]["instructions"]>["qris"];

type ProofOverride = {
  status: "pending_review" | "rejected" | "verified";
  resubmissionAllowed?: boolean;
};

const panelElement = (
  proof: ProofOverride | null,
  deadlineSuspended: boolean,
  overrides: {
    reason?: string;
    status?: "pending" | "succeeded" | "refunded" | "expired";
    registrationStatus?: CandidatePaymentPanelProps["payment"]["registrationStatus"];
    registrationCancellationReason?: string | null;
    isPayer?: boolean;
    canSubmitProof?: boolean;
    canResubmitProof?: boolean;
    qris?: QrisState;
    withBankDetails?: boolean;
    instructionsNote?: string | null;
  } = {},
) => (
  <UIPrimitivesProvider>
    <CandidatePaymentPanel
      expectedUserId="user-1"
      competitionId="comp-1"
      registrationId="reg-1"
      payment={{
        currency: "IDR",
        grossAmount: 150_000,
        dueAt: DUE,
        deadlineSuspended,
        status: overrides.status ?? "pending",
        registrationStatus: overrides.registrationStatus ?? "confirmed",
        registrationCancellationReason: overrides.registrationCancellationReason ?? null,
        instructions: {
          bankName: overrides.withBankDetails === false ? null : "Bank Mandiri",
          accountNumber: overrides.withBankDetails === false ? null : "1370012345678",
          accountHolderName: overrides.withBankDetails === false ? null : "Yayasan Uji",
          qris: overrides.qris ?? { kind: "none" },
          instructionsNote: overrides.instructionsNote ?? null,
        },
        proof:
          proof === null
            ? null
            : {
                status: proof.status,
                submittedAt: new Date().toISOString(),
                originalFileName: "bukti.jpg",
                rejectionReason: overrides.reason ?? "Nominal tidak sesuai",
                resubmissionAllowed: proof.resubmissionAllowed ?? true,
              },
        isPayer: overrides.isPayer ?? true,
        canSubmitProof: overrides.canSubmitProof ?? false,
        canResubmitProof: overrides.canResubmitProof ?? false,
      }}
    />
  </UIPrimitivesProvider>
);

const renderPanel = (...args: Parameters<typeof panelElement>) => render(panelElement(...args));

const DEADLINE_REFERENCE = /sebelum batas waktu/i;
const AUTO_CANCEL = /dibatalkan secara otomatis/i;
const SUSPENDED = /Tidak berlaku selama bukti transfer Anda ditinjau/i;

describe("the rejection notice and the clock", () => {
  it("tells a RESUBMITTABLE candidate to act before the deadline", () => {
    renderPanel({ status: "rejected", resubmissionAllowed: true }, false);

    expect(screen.getAllByText(DEADLINE_REFERENCE).length).toBeGreaterThan(0);
  });

  it("tells a BARRED candidate the deadline still runs and what happens when it passes", () => {
    // The state with no action available. Without this the notice reads "hubungi penyelenggara"
    // with no urgency attached to the one state that has the most.
    renderPanel({ status: "rejected", resubmissionAllowed: false }, false);

    expect(screen.getAllByText(DEADLINE_REFERENCE).length).toBeGreaterThan(0);
    expect(screen.getAllByText(AUTO_CANCEL).length).toBeGreaterThan(0);
  });

  it("does NOT hurry a candidate whose proof is under review", () => {
    // Suspension precedence, unchanged: expiry cannot reach this candidate, so nothing here may
    // imply a clock. This is the pairing that stops the fix above becoming urgency everywhere.
    renderPanel({ status: "pending_review" }, true);

    expect(screen.getAllByText(SUSPENDED).length).toBeGreaterThan(0);
    expect(screen.queryByText(AUTO_CANCEL)).toBeNull();
  });
});

// A REGISTRATION THE PERSON WITHDREW IS NOT OWED ANYTHING.
//
// After a withdrawal and a new registration, the old registration's page kept the old payment's
// countdown, amount and account, and once the deadline passed it said the registration was
// cancelled "secara otomatis" when nobody had cancelled it automatically. Each assertion below that
// a detail is absent is paired with one that the same detail is present for a registration that
// was not withdrawn, so a panel that never rendered the detail would not pass.
describe("the panel of a registration the person withdrew", () => {
  const WITHDRAWN_NOTICE =
    "Anda telah membatalkan pendaftaran ini. Pembayarannya tidak perlu dilanjutkan.";
  const QRIS_URL = "https://storage.example.test/signed-link";
  const withdrawn = {
    registrationStatus: "cancelled",
    registrationCancellationReason: "Saya berhalangan hadir",
  } as const;
  const AUTOMATIC = /secara otomatis/i;

  it("shows the withdrawal notice and no countdown, amount, account or QRIS", () => {
    renderPanel(null, false, { ...withdrawn, qris: { kind: "shown", url: QRIS_URL } });

    expect(screen.getByText(WITHDRAWN_NOTICE)).toBeTruthy();
    expect(screen.queryByText(/hari lagi/)).toBeNull();
    expect(screen.queryByText("Jumlah")).toBeNull();
    expect(screen.queryByText(/150\.000/)).toBeNull();
    expect(screen.queryByText("Batas waktu")).toBeNull();
    expect(screen.queryByText("Tujuan transfer")).toBeNull();
    expect(screen.queryByText("1370012345678")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".status-badge")).toBeNull();
  });

  it("shows the same details for a registration that was not withdrawn", () => {
    renderPanel(null, false, { qris: { kind: "shown", url: QRIS_URL } });

    expect(screen.queryByText(WITHDRAWN_NOTICE)).toBeNull();
    expect(screen.getByText("Jumlah")).toBeTruthy();
    expect(screen.getByText("Batas waktu")).toBeTruthy();
    expect(screen.getByText("Tujuan transfer")).toBeTruthy();
    expect(screen.getByText("1370012345678")).toBeTruthy();
    expect(document.querySelector("img")).not.toBeNull();
    expect(document.querySelector(".section-heading .status-badge")?.textContent).toMatch(
      /hari lagi/,
    );
  });

  it("does not report an automatic cancellation once the old deadline has passed", () => {
    renderPanel(null, false, { ...withdrawn, status: "expired" });

    expect(screen.getByText(WITHDRAWN_NOTICE)).toBeTruthy();
    expect(screen.queryByText(AUTOMATIC)).toBeNull();
  });

  it("still reports an automatic cancellation for an expired payment of a live registration", () => {
    renderPanel(null, false, { status: "expired" });

    expect(screen.getByText(AUTOMATIC)).toBeTruthy();
    expect(screen.queryByText(WITHDRAWN_NOTICE)).toBeNull();
  });

  it("still reports an automatic cancellation when the platform cancelled it for the deadline", () => {
    renderPanel(null, false, {
      status: "expired",
      registrationStatus: "cancelled",
      registrationCancellationReason: "payment_deadline_expired",
    });

    expect(screen.getByText(AUTOMATIC)).toBeTruthy();
    expect(screen.queryByText(WITHDRAWN_NOTICE)).toBeNull();
  });

  it("does not call a cancellation by the institution a withdrawal", () => {
    renderPanel(null, false, {
      registrationStatus: "cancelled",
      registrationCancellationReason: "competition_cancelled_by_institution",
    });

    expect(screen.queryByText(WITHDRAWN_NOTICE)).toBeNull();
    expect(screen.getByText("Jumlah")).toBeTruthy();
  });

  it("leaves a team member's panel as it was, even when the member's own row is cancelled", () => {
    renderPanel(null, false, { ...withdrawn, isPayer: false });

    expect(screen.queryByText(WITHDRAWN_NOTICE)).toBeNull();
    expect(
      screen.getByText(
        "Pembayaran tim ini ditangani oleh ketua tim. Anda dapat memantau statusnya di sini.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Jumlah")).toBeTruthy();
  });
});

// THE ORGANISER'S REASON IS FREE TEXT, AND BOTH ENDINGS REACH THE SCREEN.
//
// Every seeded reason ends in exactly one period, which is why neither of these was visible in any
// fixture: the panel appended a stop unconditionally, so a reason that already had one printed
// "terbaca..", and the organiser's queue appended nothing, so a reason without one ran into the
// sentence after it. One helper decides it now; these two pin both endings against it.
describe("a reason the organiser typed, however they punctuated it", () => {
  it("does not double the stop when the reason already ends in one", () => {
    renderPanel({ status: "rejected", resubmissionAllowed: false }, false, {
      reason: "Bukti tidak terbaca.",
    });

    expect(screen.getByText(/Bukti tidak terbaca\. Hubungi penyelenggara/)).toBeTruthy();
    expect(screen.queryByText(/\.\./)).toBeNull();
  });

  it("adds the stop when the reason has none, instead of running two sentences together", () => {
    renderPanel({ status: "rejected", resubmissionAllowed: true }, false, {
      reason: "Nominal transfer tidak sesuai",
    });

    expect(screen.getByText(/tidak sesuai\. Unggah bukti yang baru/)).toBeTruthy();
  });
});

// A SETTLED PAYMENT IS NOT RACING ANYTHING.
//
// `succeeded` and `refunded` outrank every other deadline state for the same reason `suspended`
// does: expiry cannot reach this payment, so a countdown next to "sudah diverifikasi" describes an
// obligation that no longer exists.
describe("the clock after the money is settled", () => {
  it("stops counting down once the payment has succeeded", () => {
    renderPanel({ status: "verified" }, false, { status: "succeeded" });

    expect(screen.queryByText(/hari lagi/)).toBeNull();
    expect(screen.getAllByText(/Tidak berlaku lagi/i).length).toBeGreaterThan(0);
  });

  it("stops counting down on a refund too", () => {
    renderPanel({ status: "verified" }, false, { status: "refunded" });

    expect(screen.queryByText(/hari lagi/)).toBeNull();
  });
});

// THE HEADER PILL, IN BOTH OF ITS TWO MODES.
//
// The pill carries the countdown whenever a deadline is running and falls back to the status label
// when it is not. Only the fallback was asserted anywhere, and a component that never rendered a
// countdown at all would have satisfied every one of those `queryByText(/hari lagi/)` nulls. The
// positive is what makes them mean something.
describe("what the header pill says", () => {
  const pill = () => document.querySelector(".section-heading .status-badge")?.textContent ?? "";

  it("counts down while the clock is running, instead of naming the status", () => {
    renderPanel({ status: "rejected", resubmissionAllowed: true }, false);

    expect(pill()).toMatch(/hari lagi/);
    expect(pill()).not.toMatch(/Perlu bukti baru/);
  });

  it("names the status once the clock is suspended", () => {
    // Evidence is with the organiser, so there is no time left to count. The reader still needs to
    // be told which state they are in.
    renderPanel({ status: "pending_review" }, true);

    expect(pill()).toBe("Menunggu verifikasi");
  });

  it("names the status once the payment has settled", () => {
    renderPanel({ status: "verified" }, false, { status: "succeeded" });

    expect(pill()).toBe("Lunas");
  });
});

// THE TRANSFER INSTRUCTION, AND THE STATES IT IS TRUE IN.
//
// It used to render unconditionally, so a settled payment told the candidate to transfer and
// upload three lines above the Keterangan row saying the deadline no longer applies, on a panel
// whose upload control had been withheld. Both directions are asserted: a present-assertion alone
// would pass against a panel that never rendered the instruction at all, and an absent-assertion
// alone would pass against one that never rendered it either.
describe("when the transfer instruction is shown", () => {
  const INSTRUCTION = /Transfer langsung ke rekening penyelenggara/;

  it("shows it while the upload control is on the page", () => {
    renderPanel(null, false, { canSubmitProof: true });
    expect(screen.getByText(INSTRUCTION)).toBeTruthy();
  });

  it("shows it while a rejected payer may still send a replacement", () => {
    renderPanel({ status: "rejected", resubmissionAllowed: true }, false, {
      canResubmitProof: true,
    });
    expect(screen.getByText(INSTRUCTION)).toBeTruthy();
  });

  it("drops it once the payment has settled", () => {
    renderPanel({ status: "verified" }, false, { status: "succeeded" });
    expect(screen.queryByText(INSTRUCTION)).toBeNull();
  });

  it("drops it once the deadline has passed and the registration is gone", () => {
    renderPanel(null, false, { status: "refunded" });
    expect(screen.queryByText(INSTRUCTION)).toBeNull();
  });

  it("drops it while the proof is under review, when there is nothing to send", () => {
    renderPanel({ status: "pending_review" }, true);
    expect(screen.queryByText(INSTRUCTION)).toBeNull();
  });
});

// THE ORGANISER'S QRIS, STATE BY STATE.
//
// The view decides who may scan (see candidate-payment-qris-db.integration.test.ts); this panel
// decides only what each state looks like. Every state is asserted in both directions, because a
// present-assertion alone passes against a panel that shows the image to everyone.
describe("the organiser's QRIS on the payment panel", () => {
  const QRIS_URL = "https://storage.example.test/signed-link";
  const SCAN_SENTENCE = "Pindai kode QRIS di atas, lalu unggah bukti transaksinya di sini.";
  const ALREADY_PAID_SENTENCE =
    "Jika Anda sudah membayar, jangan membayar lagi. Cukup unggah bukti yang baru.";
  const UNAVAILABLE_WITH_BANK =
    "Kode QRIS tidak dapat ditampilkan. Silakan transfer ke rekening di atas atau hubungi penyelenggara.";
  const UNAVAILABLE_WITHOUT_BANK =
    "Kode QRIS tidak dapat ditampilkan. Silakan hubungi penyelenggara.";
  const qrisImage = () => document.querySelector("img");

  it("shows the image on a white plate with the scan sentence to a payer who can send a proof", () => {
    renderPanel(null, false, { canSubmitProof: true, qris: { kind: "shown", url: QRIS_URL } });

    const image = screen.getByAltText("Kode QRIS penyelenggara");
    expect(image.getAttribute("src")).toBe(QRIS_URL);
    expect(image.getAttribute("loading")).toBe("eager");
    expect(image.closest(".qris-plate")).not.toBeNull();
    expect(screen.getByText(SCAN_SENTENCE)).toBeTruthy();
    expect(screen.queryByText(ALREADY_PAID_SENTENCE)).toBeNull();
  });

  it("tells a payer who may already have paid not to pay again, in place of the scan sentence", () => {
    renderPanel({ status: "rejected", resubmissionAllowed: true }, false, {
      canResubmitProof: true,
      qris: { kind: "shown", url: QRIS_URL },
    });

    expect(screen.getByAltText("Kode QRIS penyelenggara")).toBeTruthy();
    expect(screen.getByText(ALREADY_PAID_SENTENCE)).toBeTruthy();
    expect(screen.queryByText(SCAN_SENTENCE)).toBeNull();
  });

  it("keeps the Tujuan transfer block for a QRIS-only snapshot that is shown", () => {
    renderPanel(null, false, {
      canSubmitProof: true,
      withBankDetails: false,
      qris: { kind: "shown", url: QRIS_URL },
    });

    expect(screen.getByText("Tujuan transfer")).toBeTruthy();
    expect(screen.getByAltText("Kode QRIS penyelenggara")).toBeTruthy();
  });

  it("shows one line and no image when the link could not be made, naming the bank account", () => {
    renderPanel(null, false, { canSubmitProof: true, qris: { kind: "unavailable" } });

    expect(qrisImage()).toBeNull();
    expect(screen.getByText(UNAVAILABLE_WITH_BANK)).toBeTruthy();
    expect(screen.queryByText(SCAN_SENTENCE)).toBeNull();
  });

  it("tells a QRIS-only payer to contact the organiser, naming no bank account", () => {
    renderPanel(null, false, {
      canSubmitProof: true,
      withBankDetails: false,
      qris: { kind: "unavailable" },
    });

    expect(qrisImage()).toBeNull();
    expect(screen.getByText(UNAVAILABLE_WITHOUT_BANK)).toBeTruthy();
    expect(screen.queryByText(UNAVAILABLE_WITH_BANK)).toBeNull();
    expect(screen.getByText("Tujuan transfer")).toBeTruthy();
  });

  it("shows no QRIS line at all when the snapshot has none", () => {
    renderPanel(null, false, { canSubmitProof: true, qris: { kind: "none" } });

    expect(qrisImage()).toBeNull();
    expect(screen.queryByText(/QRIS/)).toBeNull();
  });

  it("shows no image and no QRIS line to a viewer outside the payer's gate", () => {
    renderPanel({ status: "pending_review" }, true, { qris: { kind: "hidden" } });

    expect(qrisImage()).toBeNull();
    expect(screen.queryByText(/QRIS/)).toBeNull();
    expect(screen.getByText("Tujuan transfer")).toBeTruthy();
  });

  it("renders no empty Tujuan transfer block for a hidden QRIS-only snapshot", () => {
    renderPanel({ status: "pending_review" }, true, {
      withBankDetails: false,
      qris: { kind: "hidden" },
    });

    expect(screen.queryByText("Tujuan transfer")).toBeNull();
  });

  it("keeps the block for a hidden QRIS-only snapshot that carries a note", () => {
    renderPanel({ status: "pending_review" }, true, {
      withBankDetails: false,
      instructionsNote: "Hubungi panitia untuk pertanyaan pembayaran.",
      qris: { kind: "hidden" },
    });

    expect(screen.getByText("Tujuan transfer")).toBeTruthy();
    expect(screen.getByText("Hubungi panitia untuk pertanyaan pembayaran.")).toBeTruthy();
  });

  it("swaps the image for the unavailable line when the image fails to load", () => {
    renderPanel(null, false, { canSubmitProof: true, qris: { kind: "shown", url: QRIS_URL } });

    fireEvent.error(screen.getByAltText("Kode QRIS penyelenggara"));

    expect(qrisImage()).toBeNull();
    expect(screen.getByText(UNAVAILABLE_WITH_BANK)).toBeTruthy();
    expect(screen.queryByText(SCAN_SENTENCE)).toBeNull();
  });

  it("shows the image again when a refresh brings a new link after the old one failed", () => {
    const LINK_A = "https://storage.example.test/signed-link-a";
    const LINK_B = "https://storage.example.test/signed-link-b";
    const { rerender } = renderPanel(null, false, {
      canSubmitProof: true,
      qris: { kind: "shown", url: LINK_A },
    });

    fireEvent.error(screen.getByAltText("Kode QRIS penyelenggara"));
    expect(screen.getByText(UNAVAILABLE_WITH_BANK)).toBeTruthy();

    rerender(
      panelElement(null, false, { canSubmitProof: true, qris: { kind: "shown", url: LINK_B } }),
    );

    expect(screen.getByAltText("Kode QRIS penyelenggara").getAttribute("src")).toBe(LINK_B);
    expect(screen.queryByText(UNAVAILABLE_WITH_BANK)).toBeNull();
  });

  describe("an image that failed before the page became interactive", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("swaps to the unavailable line on mount when the image is complete with no width", () => {
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);

      renderPanel(null, false, { canSubmitProof: true, qris: { kind: "shown", url: QRIS_URL } });

      expect(qrisImage()).toBeNull();
      expect(screen.getByText(UNAVAILABLE_WITH_BANK)).toBeTruthy();
    });

    it("keeps an image that loaded, which is complete with a width", () => {
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(280);

      renderPanel(null, false, { canSubmitProof: true, qris: { kind: "shown", url: QRIS_URL } });

      expect(screen.getByAltText("Kode QRIS penyelenggara")).toBeTruthy();
      expect(screen.getByText(SCAN_SENTENCE)).toBeTruthy();
    });

    it("keeps an image that is still loading, which is not complete", () => {
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);

      renderPanel(null, false, { canSubmitProof: true, qris: { kind: "shown", url: QRIS_URL } });

      expect(screen.getByAltText("Kode QRIS penyelenggara")).toBeTruthy();
    });
  });
});
