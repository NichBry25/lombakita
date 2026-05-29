// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamError } from "@/server/teams/team-core";

const { requireSessionRole, inviteTeamMember } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  inviteTeamMember: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/teams/team-service", () => ({ inviteTeamMember }));

import { POST } from "./route";

const candidateSession = {
  user: { id: "cand_captain", role: "candidate", email: "c@example.com" },
};
const makeContext = () => ({ params: Promise.resolve({ teamId: "team_1" }) });
const makeJsonRequest = (body: unknown) =>
  new Request("http://localhost/api/v1/teams/team_1/invitations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/v1/teams/[teamId]/invitations", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 201 with the invitation on success", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    inviteTeamMember.mockResolvedValue({
      id: "inv_1",
      invitedEmail: "i@example.com",
      expiresAt: new Date(),
    });
    const res = await POST(makeJsonRequest({ invitedEmail: "i@example.com" }), makeContext());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invitation.id).toBe("inv_1");
  });

  it("returns 422 with team_at_capacity when full", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    inviteTeamMember.mockRejectedValue(new TeamError("team_at_capacity", "full"));
    const res = await POST(makeJsonRequest({ invitedEmail: "i@example.com" }), makeContext());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("team_at_capacity");
  });

  it("returns 403 with team_not_captain when caller is not captain", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    inviteTeamMember.mockRejectedValue(new TeamError("team_not_captain", "not captain"));
    const res = await POST(makeJsonRequest({ invitedEmail: "i@example.com" }), makeContext());
    expect(res.status).toBe(403);
  });
});
