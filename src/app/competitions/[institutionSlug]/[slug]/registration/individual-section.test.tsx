// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { IndividualRegistrationSection } from "./individual-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const renderCancelledCard = (overrides: {
  canRegisterAgain: boolean;
  ctaState: "open" | "closed" | "not_yet_open";
  registrationWithheld?: boolean;
}) =>
  render(
    <UIPrimitivesProvider>
      <IndividualRegistrationSection
        competitionId="comp-1"
        ctaState={overrides.ctaState}
        initialRegistration={{ id: "reg-1", status: "cancelled" }}
        expectedUserId="user-1"
        modeLabel="Daftar"
        cancellationClosedByPaymentProof={false}
        registrationWithheld={overrides.registrationWithheld ?? false}
        canRegisterAgain={overrides.canRegisterAgain}
      />
    </UIPrimitivesProvider>,
  );

describe("the cancelled registration card", () => {
  it("offers the register button while registration is open", () => {
    renderCancelledCard({ canRegisterAgain: true, ctaState: "open" });

    expect(
      screen.getByText("Anda dapat mendaftar lagi selama pendaftaran masih dibuka."),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Daftar" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("says registering again waits for an open registration", () => {
    renderCancelledCard({ canRegisterAgain: true, ctaState: "closed" });

    expect(
      screen.getByText("Pendaftaran ulang hanya bisa dilakukan selama pendaftaran dibuka."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Daftar" })).toBeNull();
  });

  it("says registering again is not available after a payment proof", () => {
    renderCancelledCard({ canRegisterAgain: false, ctaState: "open" });

    expect(
      screen.getByText(
        "Pendaftaran ulang tidak tersedia karena bukti pembayaran sudah dikirim untuk pendaftaran ini.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Daftar" })).toBeNull();
  });

  it("says registering again waits while the organiser cannot take payment", () => {
    renderCancelledCard({ canRegisterAgain: true, ctaState: "open", registrationWithheld: true });

    expect(
      screen.getByText(
        "Pendaftaran ulang belum dapat dibuka selama penyelenggara belum bisa menerima pembayaran.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Daftar" })).toBeNull();
  });
});
