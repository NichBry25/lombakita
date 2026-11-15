// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { IndividualRegistrationSection } from "./individual-section";
import { sessionFetch } from "@/lib/session/session-fetch";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/session/session-fetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    sessionFetch: vi.fn(async () => ({
      ok: true,
      json: async () => ({ registration: { id: "reg-1", status: "cancelled" } }),
    })),
  };
});

const renderCancelledCard = (overrides: {
  registerAgainClosedByPaymentProof: boolean;
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
        registerAgainClosedByPaymentProof={overrides.registerAgainClosedByPaymentProof}
      />
    </UIPrimitivesProvider>,
  );

describe("the cancelled registration card", () => {
  it("offers the register button while registration is open", () => {
    renderCancelledCard({ registerAgainClosedByPaymentProof: false, ctaState: "open" });

    expect(
      screen.getByText("Anda dapat mendaftar lagi selama pendaftaran masih dibuka."),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Daftar" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("says registering again waits for an open registration", () => {
    renderCancelledCard({ registerAgainClosedByPaymentProof: false, ctaState: "closed" });

    expect(
      screen.getByText("Pendaftaran ulang hanya bisa dilakukan selama pendaftaran dibuka."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Daftar" })).toBeNull();
  });

  it("says registering again is not available after a payment proof", () => {
    renderCancelledCard({ registerAgainClosedByPaymentProof: true, ctaState: "open" });

    expect(
      screen.getByText(
        "Pendaftaran ulang tidak tersedia karena bukti transfer sudah dikirim untuk pendaftaran ini.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Daftar" })).toBeNull();
  });

  it("says registering again waits while the organiser cannot take payment", () => {
    renderCancelledCard({
      registerAgainClosedByPaymentProof: false,
      ctaState: "open",
      registrationWithheld: true,
    });

    expect(
      screen.getByText(
        "Pendaftaran ulang belum dapat dibuka selama penyelenggara belum bisa menerima pembayaran.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Daftar" })).toBeNull();
  });

  it("offers registering again right after a free registration is cancelled", async () => {
    render(
      <UIPrimitivesProvider>
        <IndividualRegistrationSection
          competitionId="comp-1"
          ctaState="open"
          initialRegistration={{ id: "reg-1", status: "confirmed" }}
          expectedUserId="user-1"
          modeLabel="Daftar"
          cancellationClosedByPaymentProof={false}
          registrationWithheld={false}
          registerAgainClosedByPaymentProof={false}
        />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Batalkan pendaftaran" }));
    fireEvent.change(screen.getByLabelText("Alasan pembatalan"), {
      target: { value: "jadwal bentrok" },
    });
    const confirmButtons = screen.getAllByRole("button", { name: "Batalkan pendaftaran" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() =>
      expect(
        screen.getByText("Anda dapat mendaftar lagi selama pendaftaran masih dibuka."),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Daftar" })).toBeTruthy());
  });
});

describe("the register button's refusals", () => {
  it("says why an owner or staff member of the competition's institution cannot register", async () => {
    vi.mocked(sessionFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { code: "registration_host_of_competition" } }),
    } as unknown as Response);
    render(
      <UIPrimitivesProvider>
        <IndividualRegistrationSection
          competitionId="comp-1"
          ctaState="open"
          initialRegistration={null}
          expectedUserId="user-1"
          modeLabel="Daftar"
          cancellationClosedByPaymentProof={false}
          registrationWithheld={false}
          registerAgainClosedByPaymentProof={false}
        />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    expect(
      await screen.findByText(
        "Anda pemilik atau staf penyelenggara kompetisi ini, jadi tidak dapat ikut mendaftar.",
      ),
    ).toBeTruthy();
  });
});
