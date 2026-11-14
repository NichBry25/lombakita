// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CompetitionTeamSection } from "./team-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const CAPTAIN = "user-captain";

const renderTeam = (
  viewerId: string,
  registerAgainClosedByPaymentProof: boolean,
  minTeamSize = 2,
) =>
  render(
    <UIPrimitivesProvider>
      <CompetitionTeamSection
        competitionId="comp-1"
        competitionMode="team"
        minTeamSize={minTeamSize}
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
            email: "kapten@example.test",
          },
          {
            membershipId: "m-2",
            userId: "user-member",
            role: "member",
            displayName: "Anggota",
            email: "anggota@example.test",
          },
        ]}
        initialPendingInvitations={[]}
        registrationWithheld={false}
        cancellationClosedByPaymentProof={false}
        isFreeCompetition={false}
        openInvitationCount={0}
        registrationClosesAt={null}
        registerAgainClosedByPaymentProof={registerAgainClosedByPaymentProof}
      />
    </UIPrimitivesProvider>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

it("withholds the register button from the captain of a team whose cancelled registration had a proof, and says why", () => {
  renderTeam(CAPTAIN, true);

  expect(screen.queryByRole("button", { name: "Daftarkan tim" })).toBeNull();
  expect(
    screen.getByText(
      "Pendaftaran ulang tim tidak tersedia karena bukti transfer sudah dikirim untuk pendaftaran tim sebelumnya. Hubungi penyelenggara jika ada kekeliruan.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Bubarkan tim" })).toBeTruthy();
});

it("explains nothing to a member of that team", () => {
  renderTeam("user-member", true);

  expect(
    screen.queryByText(
      "Pendaftaran ulang tim tidak tersedia karena bukti transfer sudah dikirim untuk pendaftaran tim sebelumnya. Hubungi penyelenggara jika ada kekeliruan.",
    ),
  ).toBeNull();
});

it("keeps the register button for a team with no such proof", () => {
  renderTeam(CAPTAIN, false);

  expect(screen.getByRole("button", { name: "Daftarkan tim" })).toBeTruthy();
  expect(
    screen.queryByText(
      "Pendaftaran ulang tim tidak tersedia karena bukti transfer sudah dikirim untuk pendaftaran tim sebelumnya. Hubungi penyelenggara jika ada kekeliruan.",
    ),
  ).toBeNull();
});

it("does not tell the captain of such a team to add members", () => {
  renderTeam(CAPTAIN, true, 3);

  expect(screen.queryByText("Tim membutuhkan minimal 3 anggota aktif")).toBeNull();
});

it("names the reason when the server refuses a team that cannot register again", async () => {
  renderTeam(CAPTAIN, false);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "team_register_again_closed_by_payment_proof",
              message:
                "A payment proof was sent for a cancelled registration of this team, so it cannot register again",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Daftarkan tim" }));

  expect(
    await screen.findByText(
      "Pendaftaran ulang tim tidak tersedia karena bukti transfer sudah dikirim untuk pendaftaran tim sebelumnya. Hubungi penyelenggara jika ada kekeliruan.",
    ),
  ).toBeTruthy();
});
