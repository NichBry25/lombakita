// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CompetitionTeamSection } from "./team-section";

const { goBack } = vi.hoisted(() => ({ goBack: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: goBack }),
}));

const CAPTAIN = "user-captain";

// Two members under a minimum of three, so the team is incomplete and backing out is guarded.
const renderIncompleteTeam = () =>
  render(
    <UIPrimitivesProvider>
      <CompetitionTeamSection
        competitionId="comp-1"
        competitionMode="team"
        minTeamSize={3}
        maxTeamSize={4}
        registrationOpen
        expectedUserId={CAPTAIN}
        initialTeam={{ id: "team-1", name: "Tim Uji", captainId: CAPTAIN, status: "forming" }}
        initialMembers={[
          {
            membershipId: "m-1",
            userId: CAPTAIN,
            role: "captain",
            displayName: "Kapten",
            email: "kapten@example.com",
          },
          {
            membershipId: "m-2",
            userId: "user-member",
            role: "member",
            displayName: "Anggota",
            email: "anggota@example.com",
          },
        ]}
        initialPendingInvitations={[]}
        registrationWithheld={false}
        cancellationClosedByPaymentProof={false}
        isFreeCompetition={false}
        openInvitationCount={0}
        registrationClosesAt={null}
        registerAgainClosedByPaymentProof={false}
      />
    </UIPrimitivesProvider>,
  );

const openLeavePopUp = () => {
  fireEvent.click(screen.getByRole("button", { name: "Detail kompetisi" }));
  return screen.getByRole("dialog");
};

afterEach(() => {
  vi.unstubAllGlobals();
  goBack.mockClear();
});

describe("the incomplete team's leave pop-up", () => {
  it("stays open, shows the failure inside and does not leave when saving is refused", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    renderIncompleteTeam();
    openLeavePopUp();

    fireEvent.click(screen.getByRole("button", { name: "Simpan dan keluar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Gagal menyimpan kompetisi. Silakan coba lagi.");
    expect(screen.getByRole("dialog").contains(alert)).toBe(true);
    expect(goBack).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stays open and does not leave when the request itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    renderIncompleteTeam();
    openLeavePopUp();

    fireEvent.click(screen.getByRole("button", { name: "Simpan dan keluar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Gagal menyimpan kompetisi. Silakan coba lagi.");
    expect(goBack).not.toHaveBeenCalled();
  });

  it("saves the competition as the signed-in user and then leaves when the save succeeds", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderIncompleteTeam();
    openLeavePopUp();

    fireEvent.click(screen.getByRole("button", { name: "Simpan dan keluar" }));

    await waitFor(() => expect(goBack).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/competitions/comp-1/save");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-Expected-User-Id")).toBe(CAPTAIN);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
