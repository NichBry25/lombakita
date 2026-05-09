// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, listCompetitionsForMember } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  listCompetitionsForMember: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/competitions/competition-service", () => ({ listCompetitionsForMember }));

import { GET } from "@/app/api/v1/institutions/[institutionSlug]/competitions/route";

const adminSession = {
  user: { id: "admin_1", role: "institution_admin", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeGet = (institutionSlug: string, qs = "") =>
  new Request(`http://localhost/api/v1/institutions/${institutionSlug}/competitions${qs}`);

const makeParams = (institutionSlug: string) => ({
  params: Promise.resolve({ institutionSlug }),
});

const memberCompetitions = {
  competitions: [
    { id: "comp_1", title: "Draft Lomba", status: "draft" },
    { id: "comp_2", title: "Published Lomba", status: "published" },
    { id: "comp_3", title: "Archived Lomba", status: "archived" },
  ],
  total: 3,
  page: 1,
};

describe("GET /api/v1/institutions/[institutionSlug]/competitions", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );
    const response = await GET(makeGet("lk-univ"), makeParams("lk-univ"));
    expect(response.status).toBe(401);
    expect(listCompetitionsForMember).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not an active institution member", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    listCompetitionsForMember.mockRejectedValue(
      new AccessError("forbidden", 403, "Institution member access required"),
    );
    const response = await GET(makeGet("lk-univ"), makeParams("lk-univ"));
    expect(response.status).toBe(403);
  });

  it("returns 200 with all statuses for an active member", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    listCompetitionsForMember.mockResolvedValue(memberCompetitions);

    const response = await GET(makeGet("lk-univ"), makeParams("lk-univ"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.competitions).toHaveLength(3);
    const statuses = body.competitions.map((c: { status: string }) => c.status);
    expect(statuses).toContain("draft");
    expect(statuses).toContain("published");
    expect(statuses).toContain("archived");
  });

  it("passes the institution slug from URL params to the service", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    listCompetitionsForMember.mockResolvedValue({ competitions: [], total: 0, page: 1 });

    await GET(makeGet("  LK-Univ  "), makeParams("  LK-Univ  "));

    expect(listCompetitionsForMember).toHaveBeenCalledWith(
      "admin_1",
      expect.objectContaining({ institutionSlug: "lk-univ" }),
    );
  });
});
