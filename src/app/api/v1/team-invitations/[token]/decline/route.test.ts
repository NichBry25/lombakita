// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamError } from "@/server/teams/team-core";

const { declineTeamInvitation } = vi.hoisted(() => ({ declineTeamInvitation: vi.fn() }));
vi.mock("@/server/teams/team-service", () => ({ declineTeamInvitation }));

import { POST } from "./route";

const makeContext = (token = "tok") => ({ params: Promise.resolve({ token }) });
const makeRequest = () =>
  new Request("http://localhost/api/v1/team-invitations/tok/decline", { method: "POST" });

describe("POST /api/v1/team-invitations/[token]/decline (unauthenticated)", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 { declined: true } on success", async () => {
    declineTeamInvitation.mockResolvedValue(undefined);
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ declined: true });
  });

  it("returns 404 with team_invite_not_found when token does not match", async () => {
    declineTeamInvitation.mockRejectedValue(
      new TeamError("team_invite_not_found", "not found"),
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("team_invite_not_found");
  });

  it("returns 410 with team_invite_not_actionable when already accepted", async () => {
    declineTeamInvitation.mockRejectedValue(
      new TeamError("team_invite_not_actionable", "already accepted"),
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(410);
  });
});
