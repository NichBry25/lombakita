// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF_SERVICE_ROLES } from "@/lib/access/roles";
import { assertSessionRole, type AuthenticatedSession } from "@/server/auth/access-core";
import { TeamError } from "@/server/teams/team-core";

const { requireSessionRole, requireAuthenticatedSession, acceptTeamInvitationForUser } = vi.hoisted(
  () => ({
    requireSessionRole: vi.fn(),
    requireAuthenticatedSession: vi.fn(),
    acceptTeamInvitationForUser: vi.fn(),
  }),
);

vi.mock("@/server/auth/session", () => ({ requireSessionRole, requireAuthenticatedSession }));
vi.mock("@/server/teams/team-service", () => ({ acceptTeamInvitationForUser }));

import { POST } from "./route";

const makeSession = (role: string, verifiedRoles: string[]): AuthenticatedSession =>
  ({
    user: { id: `${role}_1`, role, verifiedRoles, email: `${role}@example.com` },
  }) as unknown as AuthenticatedSession;

// The guards are mocked, but the role decision is not: requireSessionRole runs the production
// assertSessionRole against the session under test, so a route that asks for the wrong roles gets
// the real refusal. requireAuthenticatedSession admits any signed-in account, as the real one does.
const signInAs = (session: AuthenticatedSession) => {
  requireAuthenticatedSession.mockResolvedValue(session);
  requireSessionRole.mockImplementation(async (roles: Parameters<typeof assertSessionRole>[1]) =>
    assertSessionRole(session, roles),
  );
};

const makeContext = () => ({ params: Promise.resolve({ invitationId: "inv_1" }) });
const makeRequest = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/v1/me/invitations/team/inv_1/accept", {
    method: "POST",
    headers,
  });

beforeEach(() => {
  acceptTeamInvitationForUser.mockResolvedValue({ teamId: "team_1" });
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/v1/me/invitations/team/[invitationId]/accept", () => {
  it("gates on the self-service roles", async () => {
    signInAs(makeSession("candidate", ["candidate"]));
    await POST(makeRequest(), makeContext());
    expect(requireSessionRole).toHaveBeenCalledWith(SELF_SERVICE_ROLES);
  });

  it.each([
    { role: "platform_ops", verifiedRoles: [] },
    { role: "finance_ops", verifiedRoles: [] },
  ])("returns 403 for a $role session and never calls the accept service", async (account) => {
    signInAs(makeSession(account.role, account.verifiedRoles));
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(403);
    expect(acceptTeamInvitationForUser).not.toHaveBeenCalled();
  });

  it.each([
    { role: "candidate", verifiedRoles: ["candidate"] },
    { role: "recruiter", verifiedRoles: ["recruiter"] },
  ])("lets a $role session reach the accept service", async (account) => {
    signInAs(makeSession(account.role, account.verifiedRoles));
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, teamId: "team_1" });
    expect(acceptTeamInvitationForUser).toHaveBeenCalledWith("inv_1", `${account.role}_1`);
  });

  it("returns 409 and never calls the service when the session changed since render", async () => {
    signInAs(makeSession("candidate", ["candidate"]));
    const res = await POST(makeRequest({ "x-expected-user-id": "someone-else" }), makeContext());
    expect(res.status).toBe(409);
    expect(acceptTeamInvitationForUser).not.toHaveBeenCalled();
  });

  it("maps the service's team error to its status", async () => {
    signInAs(makeSession("candidate", ["candidate"]));
    acceptTeamInvitationForUser.mockRejectedValue(new TeamError("team_at_capacity", "full"));
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(422);
  });
});
