// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CompetitionTeamSection } from "./team-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const CAPTAIN = "user-captain";

const renderTeam = (viewerId: string) =>
  render(
    <UIPrimitivesProvider>
      <CompetitionTeamSection
        competitionId="comp-1"
        competitionMode="team"
        minTeamSize={2}
        maxTeamSize={4}
        registrationOpen
        expectedUserId={viewerId}
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
      />
    </UIPrimitivesProvider>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the team section's refusals", () => {
  it("names the organiser's payment problem when the captain registers the team", async () => {
    renderTeam(CAPTAIN);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "registration_payment_unavailable",
                message: "Kompetisi ini belum dapat menerima pembayaran. Hubungi penyelenggara.",
              },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Daftarkan tim" }));

    expect(
      await screen.findByText(
        "Penyelenggara kompetisi ini belum dapat menerima pembayaran, jadi pendaftaran berbayar belum bisa diproses. Hubungi penyelenggara.",
      ),
    ).toBeTruthy();
  });

  it("tells a member who is not the captain without showing the captain's id", async () => {
    renderTeam("user-member");

    expect(
      await screen.findByText("Hanya kapten yang dapat mendaftarkan atau membubarkan tim."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("user-cap");
  });
});
