// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { OpsPaymentActions, type OpsCompetitionView } from "./ops-payment-actions";

const COMPETITION: OpsCompetitionView = {
  competitionId: "comp_1",
  title: "Lomba Robotik",
  institutionSlug: "universitas-contoh",
  slug: "lomba-robotik",
  status: "published",
  cancellable: true,
  proofs: [
    {
      proofId: "proof_1",
      status: "pending_review",
      submittedAt: "2026-11-01T00:00:00.000Z",
      attempt: 0,
      grossAmount: 150_000,
      currency: "IDR",
      dueAt: null,
      payerDisplayName: "Dewi Lestari",
      voidable: true,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what the operator is told when a cancellation is refused", () => {
  it("names the transfers to resolve first while one is still in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "ops_competition_payment_in_flight", message: "in flight" },
          }),
          { status: 409 },
        ),
      ),
    );
    render(
      <UIPrimitivesProvider>
        <OpsPaymentActions competitions={[COMPETITION]} barredProofs={[]} />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Batalkan kompetisi" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Alasan"), { target: { value: "acara dibatalkan" } });
    fireEvent.click(dialog.getByRole("button", { name: "Batalkan kompetisi" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Kompetisi tidak dapat dibatalkan selama masih ada bukti transfer yang menunggu verifikasi atau sudah diverifikasi. Selesaikan dulu setiap bukti yang menunggu: penyelenggara memverifikasi atau menolaknya, atau Anda membatalkan bukti itu. Kompetisi dengan transfer yang sudah diverifikasi tidak dapat dibatalkan.",
        ),
      ).toBeTruthy();
    });
  });
});
