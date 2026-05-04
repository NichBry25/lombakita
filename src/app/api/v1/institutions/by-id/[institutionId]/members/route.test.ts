// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, listActiveMembers } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  listActiveMembers: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ listActiveMembers }));

import { GET } from "@/app/api/v1/institutions/by-id/[institutionId]/members/route";

const adminSession = {
  user: { id: "actor_1", role: "institution_admin", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const memberFixtures = [
  {
    membershipId: "m1",
    userId: "u1",
    name: "Alice",
    email: "alice@example.com",
    role: "institution_admin",
    joinedAt: new Date("2026-01-01"),
  },
  {
    membershipId: "m2",
    userId: "u2",
    name: "Bob",
    email: "bob@example.com",
    role: "institution_staff",
    joinedAt: new Date("2026-02-01"),
  },
];

const makeParams = (institutionId: string) => ({
  params: Promise.resolve({ institutionId }),
});

describe("GET /api/v1/institutions/by-id/[institutionId]/members", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns active members for institution admin", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    listActiveMembers.mockResolvedValue(memberFixtures);

    const response = await GET(new Request("http://localhost") as never, makeParams("inst_1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.members).toHaveLength(2);
    expect(listActiveMembers).toHaveBeenCalledWith("actor_1", "inst_1");
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await GET(new Request("http://localhost") as never, makeParams("inst_1"));
    expect(response.status).toBe(401);
  });

  it("returns 403 when caller is not institution admin", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    listActiveMembers.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_admin access required"),
    );

    const response = await GET(new Request("http://localhost") as never, makeParams("inst_other"));
    expect(response.status).toBe(403);
  });
});
