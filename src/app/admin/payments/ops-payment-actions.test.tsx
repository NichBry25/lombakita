// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { OpsPaymentActions, type OpsCompetitionView } from "./ops-payment-actions";

const COMPETITION: OpsCompetitionView = {
  competitionId: "comp_1",
  title: "Lomba Robotik",
  institutionSlug: "universitas-contoh",
  slug: "lomba-robotik",
  status: "published",
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

describe("what an operator can do on a blocked competition", () => {
  it("offers the bukti transfer void and no competition cancellation", () => {
    render(
      <UIPrimitivesProvider>
        <OpsPaymentActions competitions={[COMPETITION]} barredProofs={[]} />
      </UIPrimitivesProvider>,
    );

    expect(screen.getByRole("button", { name: "Batalkan bukti transfer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Batalkan kompetisi" })).toBeNull();
  });

  it("offers no competition cancellation on a competition that is no longer published", () => {
    render(
      <UIPrimitivesProvider>
        <OpsPaymentActions competitions={[{ ...COMPETITION, status: "draft" }]} barredProofs={[]} />
      </UIPrimitivesProvider>,
    );

    expect(screen.getByText("Tidak terbit")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Batalkan kompetisi" })).toBeNull();
  });
});
