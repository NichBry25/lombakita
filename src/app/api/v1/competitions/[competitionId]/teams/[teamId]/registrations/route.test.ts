// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { TeamError } from "@/server/teams/team-core";

const { requireSessionRole, submitTeamRegistration, cancelTeamRegistration } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  submitTeamRegistration: vi.fn(),
  cancelTeamRegistration: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/teams/team-registration-service", () => ({
  submitTeamRegistration,
  cancelTeamRegistration,
}));

import { DELETE, POST } from "./route";

const candidateSession = {
  user: { id: "cand_1", role: "candidate", email: "c@example.com" },
};

const makeContext = () => ({
  params: Promise.resolve({ competitionId: "comp_1", teamId: "team_1" }),
});

const makeRequest = (
  method: "POST" | "DELETE",
  headers: Record<string, string> = {},
) =>
  new Request(
    "http://localhost/api/v1/competitions/comp_1/teams/team_1/registrations",
    { method, headers },
  );

afterEach(() => vi.clearAllMocks());

describe("POST /api/v1/competitions/[competitionId]/teams/[teamId]/registrations", () => {
  it("returns 201 with submission result on happy path", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    submitTeamRegistration.mockResolvedValue({
      teamId: "team_1",
      status: "submitted",
      registrations: [{ id: "reg_1", studentId: "cand_1", status: "confirmed" }],
    });

    const res = await POST(makeRequest("POST"), makeContext());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.registration.status).toBe("submitted");
    expect(submitTeamRegistration).toHaveBeenCalledWith("cand_1", "comp_1", "team_1");
  });

  it("returns 401 when unauthenticated and never touches the service", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));
    const res = await POST(makeRequest("POST"), makeContext());
    expect(res.status).toBe(401);
    expect(submitTeamRegistration).not.toHaveBeenCalled();
  });

  it("returns 403 when role is recruiter", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));
    const res = await POST(makeRequest("POST"), makeContext());
    expect(res.status).toBe(403);
  });

  it("forwards team_not_captain with 403", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    submitTeamRegistration.mockRejectedValue(new TeamError("team_not_captain", "x"));
    const res = await POST(makeRequest("POST"), makeContext());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("team_not_captain");
  });

  it("forwards team_not_found with 404 (URL teamId/competition mismatch)", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    submitTeamRegistration.mockRejectedValue(new TeamError("team_not_found", "x"));
    const res = await POST(makeRequest("POST"), makeContext());
    expect(res.status).toBe(404);
  });

  it("forwards team_registration_not_allowed with 422", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    submitTeamRegistration.mockRejectedValue(
      new TeamError("team_registration_not_allowed", "Mode individual"),
    );
    const res = await POST(makeRequest("POST"), makeContext());
    expect(res.status).toBe(422);
  });

  it("forwards team_member_already_registered with 409", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    submitTeamRegistration.mockRejectedValue(
      new TeamError("team_member_already_registered", "x"),
    );
    const res = await POST(makeRequest("POST"), makeContext());
    expect(res.status).toBe(409);
  });

  // Cross-session form-submission guard: header carries a different user id than the resolved
  // session. Endpoint must 409 BEFORE the service is invoked.
  it("returns 409 session_user_mismatch when X-Expected-User-Id differs from session", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    const res = await POST(
      makeRequest("POST", { "X-Expected-User-Id": "someone_else" }),
      makeContext(),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("session_user_mismatch");
    expect(submitTeamRegistration).not.toHaveBeenCalled();
  });

  it("passes through when X-Expected-User-Id matches session.user.id", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    submitTeamRegistration.mockResolvedValue({
      teamId: "team_1",
      status: "submitted",
      registrations: [],
    });
    const res = await POST(
      makeRequest("POST", { "X-Expected-User-Id": "cand_1" }),
      makeContext(),
    );
    expect(res.status).toBe(201);
  });
});

describe("DELETE /api/v1/competitions/[competitionId]/teams/[teamId]/registrations", () => {
  it("returns 200 with reverted result on happy path", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    cancelTeamRegistration.mockResolvedValue({
      teamId: "team_1",
      status: "forming",
      registrations: [{ id: "reg_1", studentId: "cand_1", status: "cancelled" }],
    });

    const res = await DELETE(makeRequest("DELETE"), makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registration.status).toBe("forming");
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));
    const res = await DELETE(makeRequest("DELETE"), makeContext());
    expect(res.status).toBe(401);
    expect(cancelTeamRegistration).not.toHaveBeenCalled();
  });

  it("forwards team_not_submitted with 409", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    cancelTeamRegistration.mockRejectedValue(new TeamError("team_not_submitted", "x"));
    const res = await DELETE(makeRequest("DELETE"), makeContext());
    expect(res.status).toBe(409);
  });

  it("returns 409 session_user_mismatch on DELETE when header differs from session", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    const res = await DELETE(
      makeRequest("DELETE", { "X-Expected-User-Id": "someone_else" }),
      makeContext(),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("session_user_mismatch");
    expect(cancelTeamRegistration).not.toHaveBeenCalled();
  });
});
