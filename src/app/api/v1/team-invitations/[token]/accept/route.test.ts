// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { TeamError } from "@/server/teams/team-core";

const { requireSessionRole, acceptTeamInvitation } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  acceptTeamInvitation: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/teams/team-service", () => ({ acceptTeamInvitation }));

import { POST } from "./route";

const candidateSession = {
  user: { id: "cand_1", role: "candidate", email: "c@example.com" },
};
const makeContext = (token = "abc123") => ({ params: Promise.resolve({ token }) });
const makeRequest = () =>
  new Request("http://localhost/api/v1/team-invitations/abc/accept", { method: "POST" });

describe("POST /api/v1/team-invitations/[token]/accept", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with the team id on success", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    acceptTeamInvitation.mockResolvedValue({ teamId: "team_1" });
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.teamId).toBe("team_1");
    expect(acceptTeamInvitation).toHaveBeenCalledWith("abc123", "cand_1");
  });

  it("returns 401 when unauthenticated (session is confirmed before token lookup)", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(401);
    expect(acceptTeamInvitation).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a candidate", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(403);
    expect(acceptTeamInvitation).not.toHaveBeenCalled();
  });

  it("returns 403 with team_invite_email_mismatch when emails differ", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    acceptTeamInvitation.mockRejectedValue(
      new TeamError("team_invite_email_mismatch", "wrong account"),
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("team_invite_email_mismatch");
  });

  it("returns 410 with team_invite_not_actionable when expired", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    acceptTeamInvitation.mockRejectedValue(
      new TeamError("team_invite_not_actionable", "Invitation has expired"),
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error.code).toBe("team_invite_not_actionable");
  });
});
