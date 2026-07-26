// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, requireAdminInstitutionBySlug } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  requireAdminInstitutionBySlug: vi.fn(),
}));

const mockSelect = vi.fn();

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ requireAdminInstitutionBySlug }));
vi.mock("@/server/db/client", () => ({
  getDb: vi.fn(() => ({
    select: mockSelect,
  })),
}));

import { GET } from "./route";

const ownerSession = {
  user: { id: "owner_1", role: "recruiter", email: "owner@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const makeGet = (page?: string) =>
  new Request(
    `http://localhost/api/v1/institutions/lk-univ/audit-log${page ? `?page=${page}` : ""}`,
    { method: "GET" },
  );

const makeParams = () => ({
  params: Promise.resolve({ institutionSlug: "lk-univ" }),
});

// Build a mock select chain that returns data when awaited or .limit().offset().
const makeSelectChain = (result: unknown[], count = 0) => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => chain;
  chain.limit = () => chain;
  chain.offset = () => Promise.resolve(result);
  // For the COUNT query
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve([{ count }]).then(resolve, reject);
  return chain;
};

describe("GET /api/v1/institutions/[institutionSlug]/audit-log", () => {
  afterEach(() => vi.clearAllMocks());

  it("(a) returns 200 with institution-scoped events for institution_owner", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({
      institutionId: "inst_1",
      actorMembershipId: "mem_1",
    });

    const events = [
      {
        id: "evt_1",
        eventType: "review_status_changed",
        actorName: "Budi",
        metadata: {},
        createdAt: new Date(),
      },
    ];
    // Two calls: events query + count query
    mockSelect
      .mockReturnValueOnce(makeSelectChain(events, 1))
      .mockReturnValueOnce(makeSelectChain([], 1));

    const res = await GET(makeGet(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe("review_status_changed");
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
  });

  it("(b) returns empty events array when no audit log entries", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({
      institutionId: "inst_1",
      actorMembershipId: "mem_1",
    });

    mockSelect
      .mockReturnValueOnce(makeSelectChain([], 0))
      .mockReturnValueOnce(makeSelectChain([], 0));

    const res = await GET(makeGet(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("(c) returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const res = await GET(makeGet(), makeParams());
    expect(res.status).toBe(401);
  });

  it("(d) returns 403 for institution_member (CCR-09 / cross-institution)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner or institution_staff access required"),
    );

    const res = await GET(makeGet(), makeParams());
    expect(res.status).toBe(403);
  });

  it("(e) does not expose raw membership_id or institution_id in response", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({
      institutionId: "inst_1",
      actorMembershipId: "mem_1",
    });

    const events = [
      {
        id: "evt_1",
        eventType: "result_published",
        actorName: "Staff A",
        metadata: { competitionId: "comp_1" },
        createdAt: new Date(),
      },
    ];
    mockSelect
      .mockReturnValueOnce(makeSelectChain(events, 1))
      .mockReturnValueOnce(makeSelectChain([], 1));

    const res = await GET(makeGet(), makeParams());
    const body = await res.json();
    const eventKeys = Object.keys(body.events[0]);
    expect(eventKeys).not.toContain("institutionId");
    expect(eventKeys).not.toContain("targetMembershipId");
    expect(eventKeys).not.toContain("actorUserId");
    // actorName is the resolved display field
    expect(eventKeys).toContain("actorName");
  });
});
