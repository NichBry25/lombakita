// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, listActiveMembers } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  listActiveMembers: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ listActiveMembers }));

import { GET } from "@/app/api/v1/institutions/[institutionSlug]/members/route";

const ownerSession = {
  user: { id: "actor_1", role: "recruiter", email: "owner@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const memberFixtures = [
  {
    membershipId: "m1",
    userId: "u1",
    name: "Alice",
    email: "alice@example.com",
    role: "institution_owner",
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

const makeParams = (institutionSlug: string) => ({
  params: Promise.resolve({ institutionSlug }),
});

describe("GET /api/v1/institutions/[institutionSlug]/members", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns active members for institution admin", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    listActiveMembers.mockResolvedValue(memberFixtures);

    const response = await GET(new Request("http://localhost") as never, makeParams("test-org"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.members).toHaveLength(2);
    expect(listActiveMembers).toHaveBeenCalledWith("actor_1", "test-org");
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await GET(new Request("http://localhost") as never, makeParams("test-org"));
    expect(response.status).toBe(401);
  });

  it("returns 403 when caller is not institution owner or staff", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    listActiveMembers.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner or institution_staff access required"),
    );

    const response = await GET(new Request("http://localhost") as never, makeParams("other-org"));
    expect(response.status).toBe(403);
  });
});
