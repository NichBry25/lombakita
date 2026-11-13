// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ParticipantRecord } from "@/server/participants/participant-service";
import { ParticipantTeamMembers } from "./participant-team-members";

type Team = NonNullable<ParticipantRecord["team"]>;

const teamWith = (pendingTeammates: Team["pendingTeammates"]): Team => ({
  teamId: "team-1",
  teamName: "Tim Uji",
  captainDisplayName: "Budi Santoso",
  activeMemberCount: 1,
  members: [{ userId: "u-1", displayName: "Budi Santoso", username: "budi", isCaptain: true }],
  pendingTeammates,
});

describe("the organiser's team cell", () => {
  it("lists a pending teammate with an account by username, not yet joined", () => {
    const markup = renderToStaticMarkup(
      <ParticipantTeamMembers
        team={teamWith([{ invitationId: "inv-1", username: "dewi_lomba" }])}
      />,
    );

    expect(markup).toContain("Tim Uji (1 anggota)");
    expect(markup).toContain("Budi Santoso (Kapten)");
    expect(markup).toContain("dewi_lomba (belum bergabung)");
  });

  it("lists an email invite without an account and without its address", () => {
    const markup = renderToStaticMarkup(
      <ParticipantTeamMembers team={teamWith([{ invitationId: "inv-2", username: null }])} />,
    );

    expect(markup).toContain("Undangan ke email, belum punya akun");
    expect(markup).not.toContain("@");
  });
});
