// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CompetitionTeamSection } from "./team-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const CAPTAIN = "user-captain";
const CLOSES_AT = "2026-12-15T16:59:00.000Z";

const PENDING_INVITATION = {
  id: "inv-1",
  tokenHash: "hash-1",
  invitedEmail: "sari@example.test",
  expiresAt: CLOSES_AT,
};

type TeamOptions = {
  viewerId?: string;
  status?: "forming" | "submitted";
  isFreeCompetition: boolean;
  registrationOpen?: boolean;
  openInvitationCount?: number;
  registrationClosesAt?: string | null;
  pendingInvitations?: (typeof PENDING_INVITATION)[];
};

const renderTeam = ({
  viewerId = CAPTAIN,
  status = "forming",
  isFreeCompetition,
  registrationOpen = true,
  openInvitationCount = 0,
  registrationClosesAt = null,
  pendingInvitations = [],
}: TeamOptions) =>
  render(
    <UIPrimitivesProvider>
      <CompetitionTeamSection
        competitionId="comp-1"
        competitionMode="team"
        minTeamSize={3}
        maxTeamSize={3}
        registrationOpen={registrationOpen}
        expectedUserId={viewerId}
        initialTeam={{ id: "team-1", name: "Tim Uji", captainId: CAPTAIN, status }}
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
        isFreeCompetition={isFreeCompetition}
        openInvitationCount={openInvitationCount}
        registrationClosesAt={registrationClosesAt}
        registerAgainClosedByPaymentProof={false}
      />
    </UIPrimitivesProvider>,
  );

const REGISTERED_NOTE_START =
  "Tim sudah terdaftar. Undangan yang belum dijawab berlaku sampai pendaftaran ditutup pada";
const ANYONE_WHO_ACCEPTS = "Siapa pun yang menerima sebelum itu langsung terdaftar bersama tim.";
const CAPTAIN_SENTENCE =
  "Sampai saat itu, Anda masih dapat membatalkan undangan dan mengundang orang lain.";

const pageText = (): string => document.body.textContent ?? "";

afterEach(() => cleanup());

describe("the team section of a free competition", () => {
  it("lets a free team register once joined members and open invites reach the minimum", () => {
    renderTeam({
      isFreeCompetition: true,
      openInvitationCount: 1,
      pendingInvitations: [PENDING_INVITATION],
    });

    const button = screen.getByRole("button", { name: "Daftarkan tim" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("keeps a paid team's register button off until every member has joined", () => {
    renderTeam({
      isFreeCompetition: false,
      openInvitationCount: 1,
      pendingInvitations: [PENDING_INVITATION],
    });

    const button = screen.getByRole("button", { name: "Daftarkan tim" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("Tim membutuhkan minimal 3 anggota aktif");
  });

  it("names members and open invites in a free team's size reason", () => {
    renderTeam({ isFreeCompetition: true, openInvitationCount: 0 });

    const button = screen.getByRole("button", { name: "Daftarkan tim" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(
      "Tim membutuhkan minimal 3 orang, dihitung dari anggota dan undangan yang masih berlaku",
    );
  });

  it("lets the captain of a registered free team invite and cancel until registration closes", () => {
    renderTeam({
      status: "submitted",
      isFreeCompetition: true,
      registrationClosesAt: CLOSES_AT,
      openInvitationCount: 1,
      pendingInvitations: [PENDING_INVITATION],
    });

    expect(screen.getByRole("button", { name: "Undang" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Batalkan" })).toBeTruthy();
    expect(pageText()).toContain(REGISTERED_NOTE_START);
    expect(pageText()).toContain(ANYONE_WHO_ACCEPTS);
    expect(pageText()).toContain(CAPTAIN_SENTENCE);
  });

  it("tells a member of a registered free team when invites close, without the captain's controls", () => {
    renderTeam({
      viewerId: "user-member",
      status: "submitted",
      isFreeCompetition: true,
      registrationClosesAt: CLOSES_AT,
      openInvitationCount: 1,
      pendingInvitations: [PENDING_INVITATION],
    });

    expect(pageText()).toContain(REGISTERED_NOTE_START);
    expect(pageText()).toContain(ANYONE_WHO_ACCEPTS);
    expect(pageText()).not.toContain(CAPTAIN_SENTENCE);
    expect(screen.queryByRole("button", { name: "Undang" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Batalkan" })).toBeNull();
  });

  it("shows a registered paid team no invite controls, as today", () => {
    renderTeam({
      status: "submitted",
      isFreeCompetition: false,
      registrationClosesAt: CLOSES_AT,
      pendingInvitations: [PENDING_INVITATION],
    });

    expect(screen.queryByRole("button", { name: "Undang" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Batalkan" })).toBeNull();
    expect(pageText()).not.toContain("Tim sudah terdaftar.");
  });

  it("closes invites on a registered free team once registration has closed", () => {
    renderTeam({
      status: "submitted",
      isFreeCompetition: true,
      registrationOpen: false,
      registrationClosesAt: CLOSES_AT,
      pendingInvitations: [PENDING_INVITATION],
    });

    expect(screen.queryByRole("button", { name: "Undang" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Batalkan" })).toBeNull();
    expect(pageText()).not.toContain("Tim sudah terdaftar.");
  });
});
