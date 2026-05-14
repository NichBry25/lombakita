// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { CompetitionError } from "@/server/competitions/competition-core";

const { requireAuthenticatedSession, createCompetitionDraft, listPublicCompetitions } = vi.hoisted(
  () => ({
    requireAuthenticatedSession: vi.fn(),
    createCompetitionDraft: vi.fn(),
    listPublicCompetitions: vi.fn(),
  }),
);

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/competitions/competition-service", () => ({ createCompetitionDraft }));
vi.mock("@/server/competitions/competition-public-service", () => ({ listPublicCompetitions }));

import { GET, POST } from "@/app/api/v1/competitions/route";

const adminSession = {
  user: { id: "admin_1", role: "recruiter", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makePost = (body: unknown) =>
  new Request("http://localhost/api/v1/competitions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const makeGet = (qs: string) => new Request(`http://localhost/api/v1/competitions${qs}`);

describe("POST /api/v1/competitions", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 201 on create draft", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createCompetitionDraft.mockResolvedValue({
      id: "comp_1",
      institutionId: "inst_1",
      slug: "lomba-x",
      title: "Lomba Coding 2026",
      status: "draft",
    });
    const response = await POST(makePost({ institutionSlug: "lk", title: "Lomba Coding 2026" }));
    expect(response.status).toBe(201);
    expect(createCompetitionDraft).toHaveBeenCalledWith(
      "admin_1",
      expect.objectContaining({ institutionSlug: "lk", title: "Lomba Coding 2026" }),
    );
  });

  it("silently strips status and institutionId from body on create", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createCompetitionDraft.mockResolvedValue({
      id: "comp_1",
      institutionId: "inst_1",
      slug: "lomba-x",
      title: "Lomba Coding 2026",
      status: "draft",
    });
    const response = await POST(
      makePost({
        institutionSlug: "lk",
        title: "Lomba Coding 2026",
        status: "published",
        institutionId: "evil-inst",
        feeAmount: 100,
      }),
    );
    expect(response.status).toBe(201);
    const arg = createCompetitionDraft.mock.calls[0]?.[1] as Record<string, unknown>;
    expect("status" in arg).toBe(false);
    expect("institutionId" in arg).toBe(false);
    expect("feeAmount" in arg).toBe(false);
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );
    const response = await POST(makePost({ institutionSlug: "lk", title: "Lomba Coding 2026" }));
    expect(response.status).toBe(401);
  });

  it("returns 403 when student attempts to create", async () => {
    const studentSession = {
      user: { id: "stud_1", role: "candidate", email: "stud@example.com" },
      expires: new Date(Date.now() + 60_000).toISOString(),
    };
    requireAuthenticatedSession.mockResolvedValue(studentSession);
    createCompetitionDraft.mockRejectedValue(
      new AccessError("forbidden", 403, "Institution member access required"),
    );
    const response = await POST(makePost({ institutionSlug: "lk", title: "Lomba Coding 2026" }));
    expect(response.status).toBe(403);
  });

  it("returns 400 when institutionSlug is missing", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    const response = await POST(makePost({ title: "Lomba Coding 2026" }));
    expect(response.status).toBe(400);
    expect(createCompetitionDraft).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    const response = await POST(
      new Request("http://localhost/api/v1/competitions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("returns 409 when slug is taken", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createCompetitionDraft.mockRejectedValue(
      new CompetitionError("competition_slug_taken", 409, "slug taken"),
    );
    const response = await POST(
      makePost({ institutionSlug: "lk", title: "Lomba Coding 2026", slug: "lomba-x" }),
    );
    expect(response.status).toBe(409);
  });

  it("returns 400 when slug has uppercase or spaces (Step 3.2 strict format)", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    const response = await POST(
      makePost({ institutionSlug: "lk", title: "Lomba Coding 2026", slug: "Lomba Coding" }),
    );
    expect(response.status).toBe(400);
    expect(createCompetitionDraft).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/competitions — public listing", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with data+meta without auth", async () => {
    listPublicCompetitions.mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, limit: 20, totalPages: 0, searchEngine: "db" },
    });
    const response = await GET(makeGet(""));
    expect(response.status).toBe(200);
    expect(requireAuthenticatedSession).not.toHaveBeenCalled();
    const body = (await response.json()) as { data: unknown[]; meta: unknown };
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");
  });

  it("passes q, category, sort, page to listPublicCompetitions", async () => {
    listPublicCompetitions.mockResolvedValue({
      data: [],
      meta: { total: 0, page: 2, limit: 20, totalPages: 0, searchEngine: "meilisearch" },
    });
    await GET(makeGet("?q=lomba&category=technology&sort=deadline_asc&page=2"));
    expect(listPublicCompetitions).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "lomba",
        category: "technology",
        sort: "deadline_asc",
        page: 2,
      }),
    );
  });
});
