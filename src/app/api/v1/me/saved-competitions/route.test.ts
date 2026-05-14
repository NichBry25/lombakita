// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, listSavedCompetitions } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  listSavedCompetitions: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/saved-competitions/saved-competition-service", () => ({
  listSavedCompetitions,
}));

import { GET } from "./route";

const studentSession = {
  user: { id: "stud_1", role: "candidate", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = (query = "") =>
  new Request(`http://localhost/api/v1/me/saved-competitions${query}`);

const makeResult = (overrides = {}) => ({
  data: [],
  meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
  ...overrides,
});

describe("GET /api/v1/me/saved-competitions", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with saved competitions list for an authenticated student", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    listSavedCompetitions.mockResolvedValue(makeResult());

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(makeResult());
    expect(listSavedCompetitions).toHaveBeenCalledWith("stud_1", {
      page: undefined,
      limit: undefined,
    });
  });

  it("passes page and limit query params to service", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    listSavedCompetitions.mockResolvedValue(makeResult());

    const res = await GET(makeRequest("?page=2&limit=10") as never);

    expect(res.status).toBe(200);
    expect(listSavedCompetitions).toHaveBeenCalledWith("stud_1", { page: 2, limit: 10 });
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is institution_admin (not a student)", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));

    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(403);
  });

  it("returns empty data array with correct meta when no saves exist", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    listSavedCompetitions.mockResolvedValue(makeResult());

    const res = await GET(makeRequest() as never);
    const body = (await res.json()) as ReturnType<typeof makeResult>;

    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
    expect(body.meta.totalPages).toBe(0);
  });
});
