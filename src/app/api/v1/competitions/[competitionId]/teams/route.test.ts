// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { TeamError } from "@/server/teams/team-core";

const { requireSessionRole, createTeam, getTeamForCompetitionAndCandidate } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  createTeam: vi.fn(),
  getTeamForCompetitionAndCandidate: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/teams/team-service", () => ({
  createTeam,
  getTeamForCompetitionAndCandidate,
}));

import { GET, POST } from "./route";

const candidateSession = {
  user: { id: "cand_1", role: "candidate", email: "c@example.com" },
};

const makeContext = () => ({ params: Promise.resolve({ competitionId: "comp_1" }) });

const makeJsonRequest = (body: unknown) =>
  new Request("http://localhost/api/v1/competitions/comp_1/teams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/v1/competitions/[competitionId]/teams", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 201 with the created team", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    createTeam.mockResolvedValue({ id: "team_1", name: "Tim Alfa" });
    const res = await POST(makeJsonRequest({ name: "Tim Alfa" }), makeContext());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.team.id).toBe("team_1");
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));
    const res = await POST(makeJsonRequest({ name: "x" }), makeContext());
    expect(res.status).toBe(401);
    expect(createTeam).not.toHaveBeenCalled();
  });

  it("returns 403 when role is recruiter", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));
    const res = await POST(makeJsonRequest({ name: "x" }), makeContext());
    expect(res.status).toBe(403);
  });

  it("forwards TeamError with the correct status", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    createTeam.mockRejectedValue(
      new TeamError("team_competition_mode_not_allowed", "Wrong mode"),
    );
    const res = await POST(makeJsonRequest({ name: "x" }), makeContext());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("team_competition_mode_not_allowed");
  });

  it("rejects non-JSON body with team_invalid_payload", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    const req = new Request("http://localhost/api/v1/competitions/comp_1/teams", {
      method: "POST",
      body: "not-json",
    });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("team_invalid_payload");
  });
});

describe("GET /api/v1/competitions/[competitionId]/teams", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the candidate's current team snapshot or null", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getTeamForCompetitionAndCandidate.mockResolvedValue(null);
    const res = await GET(
      new Request("http://localhost/api/v1/competitions/comp_1/teams"),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team).toBeNull();
  });
});
