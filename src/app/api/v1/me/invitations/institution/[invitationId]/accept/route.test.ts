// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF_SERVICE_ROLES } from "@/lib/access/roles";
import { assertSessionRole, type AuthenticatedSession } from "@/server/auth/access-core";
import { InstitutionInvitationError } from "@/server/institution-invitations/invitation-core";

const { requireSessionRole, requireAuthenticatedSession, acceptInstitutionInvitationForUser } =
  vi.hoisted(() => ({
    requireSessionRole: vi.fn(),
    requireAuthenticatedSession: vi.fn(),
    acceptInstitutionInvitationForUser: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({ requireSessionRole, requireAuthenticatedSession }));
vi.mock("@/server/institution-invitations/invitation-service", () => ({
  acceptInstitutionInvitationForUser,
}));

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
  new Request("http://localhost/api/v1/me/invitations/institution/inv_1/accept", {
    method: "POST",
    headers,
  });

beforeEach(() => {
  acceptInstitutionInvitationForUser.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/v1/me/invitations/institution/[invitationId]/accept", () => {
  it("gates on the self-service roles", async () => {
    signInAs(makeSession("candidate", ["candidate"]));
    await POST(makeRequest(), makeContext());
    expect(requireSessionRole).toHaveBeenCalledWith(SELF_SERVICE_ROLES);
  });

  // An operator account may also hold a verified self-service role; the route gates on the account's
  // own role, so none of these shapes may open the accept path.
  it.each(
    ["platform_ops", "finance_ops"].flatMap((role) =>
      [[], ["candidate"], ["candidate", "recruiter"]].map((verifiedRoles) => ({
        role,
        verifiedRoles,
      })),
    ),
  )(
    "returns 403 for a $role session with verifiedRoles $verifiedRoles and never calls the accept service",
    async (account) => {
      signInAs(makeSession(account.role, account.verifiedRoles));
      const res = await POST(makeRequest(), makeContext());
      expect(res.status).toBe(403);
      expect(acceptInstitutionInvitationForUser).not.toHaveBeenCalled();
    },
  );

  it.each([
    { role: "candidate", verifiedRoles: ["candidate"] },
    { role: "recruiter", verifiedRoles: ["recruiter"] },
  ])("lets a $role session reach the accept service", async (account) => {
    signInAs(makeSession(account.role, account.verifiedRoles));
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(acceptInstitutionInvitationForUser).toHaveBeenCalledWith(
      "inv_1",
      `${account.role}_1`,
      account.verifiedRoles,
    );
  });

  it("returns 409 and never calls the service when the session changed since render", async () => {
    signInAs(makeSession("candidate", ["candidate"]));
    const res = await POST(makeRequest({ "x-expected-user-id": "someone-else" }), makeContext());
    expect(res.status).toBe(409);
    expect(acceptInstitutionInvitationForUser).not.toHaveBeenCalled();
  });

  it("maps the service's invitation error to its status", async () => {
    signInAs(makeSession("candidate", ["candidate"]));
    acceptInstitutionInvitationForUser.mockRejectedValue(
      new InstitutionInvitationError("invitation_not_found", 404, "missing"),
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(404);
  });
});
