// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CompetitionTeamSection } from "./team-section";

const routerSpies = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => routerSpies }));

const CAPTAIN = "user-captain";
const CLOSED_SENTENCE =
  "Pendaftaran ulang tim tidak tersedia karena bukti transfer sudah dikirim untuk pendaftaran tim ini.";
const PENDING_INVITATION = {
  id: "inv-1",
  tokenHash: "token-1",
  invitedEmail: "undangan@example.test",
  expiresAt: "2026-09-08T00:00:00.000Z",
};

const renderTeam = (
  viewerId: string,
  registerAgainClosedByPaymentProof: boolean,
  minTeamSize = 2,
  pendingInvitations: {
    id: string;
    tokenHash: string;
    invitedEmail: string;
    expiresAt: string;
  }[] = [],
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
        initialPendingInvitations={pendingInvitations}
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
  routerSpies.refresh.mockClear();
  routerSpies.back.mockClear();
});

it("withholds the register button from the captain of a team whose cancelled registration had a proof, and says why", () => {
  renderTeam(CAPTAIN, true);

  expect(screen.queryByRole("button", { name: "Daftarkan tim" })).toBeNull();
  expect(screen.getByText(CLOSED_SENTENCE)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Bubarkan tim" })).toBeTruthy();
});

it("explains nothing to a member of that team", () => {
  renderTeam("user-member", true);

  expect(screen.queryByText(CLOSED_SENTENCE)).toBeNull();
});

it("keeps the register button for a team with no such proof", () => {
  renderTeam(CAPTAIN, false);

  expect(screen.getByRole("button", { name: "Daftarkan tim" })).toBeTruthy();
  expect(screen.queryByText(CLOSED_SENTENCE)).toBeNull();
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

  expect(await screen.findByText(CLOSED_SENTENCE)).toBeTruthy();
});

it("reads the page again when the server refuses a team that cannot register again", async () => {
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
  await screen.findByText(CLOSED_SENTENCE);

  expect({ refreshCalls: routerSpies.refresh.mock.calls.length }).toEqual({ refreshCalls: 1 });
});

it("does not read the page again on a refusal that may pass on retry", async () => {
  renderTeam(CAPTAIN, false);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "team_size_insufficient",
              message: "Team has 1 active member(s); minimum is 2",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Daftarkan tim" }));
  await screen.findByText("Tim membutuhkan minimal 2 anggota aktif.");

  expect({ refreshCalls: routerSpies.refresh.mock.calls.length }).toEqual({ refreshCalls: 0 });
});

it("withholds the invite form from the captain of a team that cannot register again, and keeps member removal", () => {
  renderTeam(CAPTAIN, true, 2, [PENDING_INVITATION]);

  expect({
    inviteField: screen.queryByPlaceholderText("Username atau Email") !== null,
    inviteButton: screen.queryByRole("button", { name: "Undang" }) !== null,
    cancelInvite: screen.queryByRole("button", { name: "Batalkan" }) !== null,
    removeMember: screen.queryByRole("button", { name: "Keluarkan Anggota dari tim" }) !== null,
    disband: screen.queryByRole("button", { name: "Bubarkan tim" }) !== null,
  }).toEqual({
    inviteField: false,
    inviteButton: false,
    cancelInvite: true,
    removeMember: true,
    disband: true,
  });
});

it("keeps the invite form for a forming team with no such proof", () => {
  renderTeam(CAPTAIN, false, 2, [PENDING_INVITATION]);

  expect({
    inviteField: screen.queryByPlaceholderText("Username atau Email") !== null,
    inviteButton: screen.queryByRole("button", { name: "Undang" }) !== null,
    cancelInvite: screen.queryByRole("button", { name: "Batalkan" }) !== null,
    removeMember: screen.queryByRole("button", { name: "Keluarkan Anggota dari tim" }) !== null,
    disband: screen.queryByRole("button", { name: "Bubarkan tim" }) !== null,
  }).toEqual({
    inviteField: true,
    inviteButton: true,
    cancelInvite: true,
    removeMember: true,
    disband: true,
  });
});

it("does not warn on leaving a team that cannot register again", () => {
  renderTeam(CAPTAIN, true, 3);
  const leaving = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leaving);
  fireEvent.click(screen.getByRole("button", { name: "Detail kompetisi" }));

  expect({
    leaveBlocked: leaving.defaultPrevented,
    modal: screen.queryByText("Tim belum lengkap") !== null,
    backCalls: routerSpies.back.mock.calls.length,
  }).toEqual({ leaveBlocked: false, modal: false, backCalls: 1 });
});

it("still warns on leaving a forming team below its minimum", async () => {
  renderTeam(CAPTAIN, false, 3);
  const leaving = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leaving);
  fireEvent.click(screen.getByRole("button", { name: "Detail kompetisi" }));
  await screen.findByText("Tim belum lengkap");

  expect({
    leaveBlocked: leaving.defaultPrevented,
    modal: screen.queryByText("Tim belum lengkap") !== null,
    backCalls: routerSpies.back.mock.calls.length,
  }).toEqual({ leaveBlocked: true, modal: true, backCalls: 0 });
});
