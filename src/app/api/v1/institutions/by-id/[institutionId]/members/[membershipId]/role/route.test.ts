// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { MemberError } from "@/server/institution-members/member-core";

const { requireAuthenticatedSession, changeMemberRole } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  changeMemberRole: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ changeMemberRole }));

import { PATCH } from "@/app/api/v1/institutions/by-id/[institutionId]/members/[membershipId]/role/route";

const adminSession = {
  user: { id: "actor_1", role: "recruiter", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = (body: unknown) =>
  new Request("http://localhost", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const makeParams = (institutionId: string, membershipId: string) => ({
  params: Promise.resolve({ institutionId, membershipId }),
});

describe("PATCH /api/v1/institutions/by-id/[institutionId]/members/[membershipId]/role", () => {
  afterEach(() => vi.clearAllMocks());

  it("changes role and returns 200", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    changeMemberRole.mockResolvedValue(undefined);

    const response = await PATCH(
      makeRequest({ role: "institution_owner" }) as never,
      makeParams("inst_1", "m2"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.updated).toBe(true);
    expect(changeMemberRole).toHaveBeenCalledWith("actor_1", "inst_1", "m2", "institution_owner");
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("inst_1", "m2"),
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 when called by non-admin", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    changeMemberRole.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner access required"),
    );

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("inst_other", "m2"),
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 on self-action", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    changeMemberRole.mockRejectedValue(
      new MemberError("member_self_action", 403, "Cannot change your own membership role"),
    );

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("inst_1", "m_self"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("member_self_action");
  });

  it("returns 409 when demoting last admin", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    changeMemberRole.mockRejectedValue(
      new MemberError("member_last_admin", 409, "Cannot demote the last institution admin"),
    );

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("inst_1", "m1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("member_last_admin");
  });

  it("returns 400 for institution_member role (excluded by CCR-09)", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);

    const response = await PATCH(
      makeRequest({ role: "institution_member" }) as never,
      makeParams("inst_1", "m2"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("member_invalid_role");
  });

  it("returns 400 for invalid JSON body", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);

    const request = new Request("http://localhost", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    const response = await PATCH(request as never, makeParams("inst_1", "m2"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("member_invalid_payload");
  });
});
