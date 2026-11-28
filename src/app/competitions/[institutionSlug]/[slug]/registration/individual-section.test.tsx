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
        competitionTitle="Seed Hackathon Nusantara"
        ctaState={overrides.ctaState}
        initialRegistration={{ id: "reg-1", status: "cancelled" }}
        expectedUserId="user-1"
        modeLabel="Daftar"
        cancellationClosedByPaymentProof={false}
        cancellationClosedForTeamRow={false}
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
          competitionTitle="Seed Hackathon Nusantara"
          ctaState="open"
          initialRegistration={{ id: "reg-1", status: "confirmed" }}
          expectedUserId="user-1"
          modeLabel="Daftar"
          cancellationClosedByPaymentProof={false}
          cancellationClosedForTeamRow={false}
          registrationWithheld={false}
          registerAgainClosedByPaymentProof={false}
        />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Batalkan pendaftaran" }));
    fireEvent.change(screen.getByLabelText(/Alasan pembatalan/), {
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
          competitionTitle="Seed Hackathon Nusantara"
          ctaState="open"
          initialRegistration={null}
          expectedUserId="user-1"
          modeLabel="Daftar"
          cancellationClosedByPaymentProof={false}
          cancellationClosedForTeamRow={false}
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

  it("says the organiser is suspended when the register button is refused", async () => {
    vi.mocked(sessionFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { code: "institution_suspended" } }),
    } as unknown as Response);
    render(
      <UIPrimitivesProvider>
        <IndividualRegistrationSection
          competitionId="comp-1"
          competitionTitle="Seed Hackathon Nusantara"
          ctaState="open"
          initialRegistration={null}
          expectedUserId="user-1"
          modeLabel="Daftar"
          cancellationClosedByPaymentProof={false}
          cancellationClosedForTeamRow={false}
          registrationWithheld={false}
          registerAgainClosedByPaymentProof={false}
        />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    expect(
      await screen.findByText(
        "Penyelenggara kompetisi ini sedang dinonaktifkan, jadi pendaftaran baru belum dapat diterima.",
      ),
    ).toBeTruthy();
  });
});

describe("the cancel pop-up", () => {
  it("names the competition, counts the reason, and an empty reason shows the field error and sends nothing", async () => {
    vi.mocked(sessionFetch).mockClear();
    render(
      <UIPrimitivesProvider>
        <IndividualRegistrationSection
          competitionId="comp-1"
          competitionTitle="Seed Hackathon Nusantara"
          ctaState="open"
          initialRegistration={{ id: "reg-1", status: "confirmed" }}
          expectedUserId="user-1"
          modeLabel="Daftar"
          cancellationClosedByPaymentProof={false}
          cancellationClosedForTeamRow={false}
          registrationWithheld={false}
          registerAgainClosedByPaymentProof={false}
        />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Batalkan pendaftaran" }));

    expect(screen.getByRole("heading", { name: "Batalkan pendaftaran Anda?" })).toBeTruthy();
    expect(
      screen.getByText("Pendaftaran Anda di Seed Hackathon Nusantara akan dibatalkan."),
    ).toBeTruthy();
    expect(screen.getByText("0 / 500")).toBeTruthy();

    const confirmButtons = screen.getAllByRole("button", { name: "Batalkan pendaftaran" });
    const mainButton = confirmButtons[confirmButtons.length - 1]! as HTMLButtonElement;
    expect(mainButton.disabled).toBe(false);
    fireEvent.click(mainButton);

    expect(
      await screen.findByText("Alasan belum diisi. Tulis alasan pembatalan Anda."),
    ).toBeTruthy();
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it("stays open and shows the failure inside when the server refuses, so the person can retry", async () => {
    vi.mocked(sessionFetch).mockClear();
    vi.mocked(sessionFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { code: "cancellation_window_closed" } }),
    } as unknown as Response);
    render(
      <UIPrimitivesProvider>
        <IndividualRegistrationSection
          competitionId="comp-1"
          competitionTitle="Seed Hackathon Nusantara"
          ctaState="open"
          initialRegistration={{ id: "reg-1", status: "confirmed" }}
          expectedUserId="user-1"
          modeLabel="Daftar"
          cancellationClosedByPaymentProof={false}
          cancellationClosedForTeamRow={false}
          registrationWithheld={false}
          registerAgainClosedByPaymentProof={false}
        />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Batalkan pendaftaran" }));
    fireEvent.change(screen.getByLabelText(/Alasan pembatalan/), {
      target: { value: "jadwal bentrok" },
    });
    const confirmButtons = screen.getAllByRole("button", { name: "Batalkan pendaftaran" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    expect(await screen.findByText("Batas waktu pembatalan telah terlewat.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("tells a stale page that the registration is a team row, and points to the team section", async () => {
    vi.mocked(sessionFetch).mockClear();
    vi.mocked(sessionFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { code: "registration_team_row_use_team_flow" } }),
    } as unknown as Response);
    render(
      <UIPrimitivesProvider>
        <IndividualRegistrationSection
          competitionId="comp-1"
          competitionTitle="Seed Hackathon Nusantara"
          ctaState="open"
          initialRegistration={{ id: "reg-1", status: "confirmed" }}
          expectedUserId="user-1"
          modeLabel="Daftar"
          cancellationClosedByPaymentProof={false}
          cancellationClosedForTeamRow={false}
          registrationWithheld={false}
          registerAgainClosedByPaymentProof={false}
        />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Batalkan pendaftaran" }));
    fireEvent.change(screen.getByLabelText(/Alasan pembatalan/), {
      target: { value: "jadwal bentrok" },
    });
    const confirmButtons = screen.getAllByRole("button", { name: "Batalkan pendaftaran" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    expect(
      await screen.findByText(
        "Pendaftaran ini terdaftar sebagai tim. Hanya ketua tim yang dapat membatalkan pendaftaran tim, lewat bagian Tim di halaman ini.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
