// @vitest-environment jsdom
//
// THE DEADLINE IS NAMED IN EVERY STATE THAT IS STILL RUNNING AGAINST ONE.
//
// A rejection resumes the clock — only `pending_review` suspends it — so both rejection branches
// are racing a deadline. The barred branch is the harshest state on the lane: the candidate cannot
// cancel (a proof exists, so surface 5 withholds it), cannot resubmit (the organiser barred it),
// and will be cancelled automatically when the clock runs out. That combination only became
// reachable once the cancel affordance, the deadline surfacing and the verdict path were all in
// place, so no single surface owned it.
//
// The suspended state is asserted alongside as the counter-case: it must NOT carry deadline
// urgency, because expiry cannot reach that candidate at all.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CandidatePaymentPanel } from "./candidate-payment-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const DUE = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

type ProofOverride = {
  status: "pending_review" | "rejected" | "verified";
  resubmissionAllowed?: boolean;
};

const renderPanel = (proof: ProofOverride | null, deadlineSuspended: boolean) =>
  render(
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
          status: "pending",
          instructions: {
            bankName: "Bank Mandiri",
            accountNumber: "1370012345678",
            accountHolderName: "Yayasan Uji",
            qrisR2Key: null,
            instructionsNote: null,
          },
          proof:
            proof === null
              ? null
              : {
                  status: proof.status,
                  submittedAt: new Date().toISOString(),
                  originalFileName: "bukti.jpg",
                  rejectionReason: "Nominal tidak sesuai",
                  resubmissionAllowed: proof.resubmissionAllowed ?? true,
                },
          isPayer: true,
          canSubmitProof: false,
          canResubmitProof: false,
        }}
      />
    </UIPrimitivesProvider>,
  );

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
