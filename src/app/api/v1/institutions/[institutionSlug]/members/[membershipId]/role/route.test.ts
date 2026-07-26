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

import { PATCH } from "@/app/api/v1/institutions/[institutionSlug]/members/[membershipId]/role/route";

const ownerSession = {
  user: { id: "actor_1", role: "recruiter", email: "owner@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = (body: unknown) =>
  new Request("http://localhost", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const makeParams = (institutionSlug: string, membershipId: string) => ({
  params: Promise.resolve({ institutionSlug, membershipId }),
});

describe("PATCH /api/v1/institutions/[institutionSlug]/members/[membershipId]/role", () => {
  afterEach(() => vi.clearAllMocks());

  it("changes role and returns 200", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    changeMemberRole.mockResolvedValue(undefined);

    const response = await PATCH(
      makeRequest({ role: "institution_owner" }) as never,
      makeParams("test-org", "m2"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.updated).toBe(true);
    expect(changeMemberRole).toHaveBeenCalledWith("actor_1", "test-org", "m2", "institution_owner");
  });

  it("allows demotion to institution_member", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    changeMemberRole.mockResolvedValue(undefined);

    const response = await PATCH(
      makeRequest({ role: "institution_member" }) as never,
      makeParams("test-org", "m2"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.updated).toBe(true);
    expect(changeMemberRole).toHaveBeenCalledWith(
      "actor_1",
      "test-org",
      "m2",
      "institution_member",
    );
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("test-org", "m2"),
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 when called by non-owner/non-staff", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    changeMemberRole.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner or institution_staff access required"),
    );

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("other-org", "m2"),
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 on self-action", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    changeMemberRole.mockRejectedValue(
      new MemberError("member_self_action", 403, "Cannot change your own membership role"),
    );

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("test-org", "m_self"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("member_self_action");
  });

  it("returns 403 for CCR-08 escalation blocked (candidate-only target, role = institution_staff)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    changeMemberRole.mockRejectedValue(
      new MemberError(
        "role_escalation_forbidden",
        403,
        "Target account must have recruiter role verified to hold owner or staff membership",
      ),
    );

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("test-org", "m_candidate"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("role_escalation_forbidden");
  });

  it("returns 200 for CCR-08 escalation allowed (recruiter-verified target, role = institution_staff)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    changeMemberRole.mockResolvedValue(undefined);

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("test-org", "m_recruiter"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.updated).toBe(true);
  });

  it("returns 422 when demoting last owner (last_owner_demotion_forbidden)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    changeMemberRole.mockRejectedValue(
      new MemberError(
        "last_owner_demotion_forbidden",
        422,
        "An institution must have at least one owner",
      ),
    );

    const response = await PATCH(
      makeRequest({ role: "institution_staff" }) as never,
      makeParams("test-org", "m1"),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("last_owner_demotion_forbidden");
  });

  it("returns 400 for invalid JSON body", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);

    const request = new Request("http://localhost", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    const response = await PATCH(request as never, makeParams("test-org", "m2"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("member_invalid_payload");
  });

  it("returns 400 for unrecognised role value", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);

    const response = await PATCH(
      makeRequest({ role: "super_admin" }) as never,
      makeParams("test-org", "m2"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("member_invalid_role");
  });
});
