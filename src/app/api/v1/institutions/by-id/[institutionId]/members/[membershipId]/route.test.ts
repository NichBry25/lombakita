// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { MemberError } from "@/server/institution-members/member-core";

const { requireAuthenticatedSession, removeMember } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ removeMember }));

import { DELETE } from "@/app/api/v1/institutions/by-id/[institutionId]/members/[membershipId]/route";

const adminSession = {
  user: { id: "actor_1", role: "recruiter", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeParams = (institutionId: string, membershipId: string) => ({
  params: Promise.resolve({ institutionId, membershipId }),
});

describe("DELETE /api/v1/institutions/by-id/[institutionId]/members/[membershipId]", () => {
  afterEach(() => vi.clearAllMocks());

  it("removes member and returns 204", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    removeMember.mockResolvedValue(undefined);

    const response = await DELETE(
      new Request("http://localhost") as never,
      makeParams("inst_1", "m2"),
    );

    expect(response.status).toBe(204);
    expect(removeMember).toHaveBeenCalledWith("actor_1", "inst_1", "m2");
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await DELETE(
      new Request("http://localhost") as never,
      makeParams("inst_1", "m2"),
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 when caller is not institution admin", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    removeMember.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_admin access required"),
    );

    const response = await DELETE(
      new Request("http://localhost") as never,
      makeParams("inst_other", "m2"),
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 on self-removal attempt", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    removeMember.mockRejectedValue(
      new MemberError("member_self_action", 403, "Cannot remove yourself from the institution"),
    );

    const response = await DELETE(
      new Request("http://localhost") as never,
      makeParams("inst_1", "m_self"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("member_self_action");
  });

  it("returns 409 when removing last admin", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    removeMember.mockRejectedValue(
      new MemberError("member_last_admin", 409, "Cannot remove the last institution admin"),
    );

    const response = await DELETE(
      new Request("http://localhost") as never,
      makeParams("inst_1", "m1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("member_last_admin");
  });

  it("returns 404 when member not found", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    removeMember.mockRejectedValue(new MemberError("member_not_found", 404, "Member not found"));

    const response = await DELETE(
      new Request("http://localhost") as never,
      makeParams("inst_1", "m_unknown"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("member_not_found");
  });
});
