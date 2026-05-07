// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { CompetitionError } from "@/server/competitions/competition-core";

const {
  requireAuthenticatedSession,
  getCompetitionForReader,
  updateCompetitionDraft,
  softDeleteCompetitionDraft,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  getCompetitionForReader: vi.fn(),
  updateCompetitionDraft: vi.fn(),
  softDeleteCompetitionDraft: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/competitions/competition-service", () => ({
  getCompetitionForReader,
  updateCompetitionDraft,
  softDeleteCompetitionDraft,
}));

import { DELETE, GET, PATCH } from "@/app/api/v1/competitions/[competitionId]/route";

const adminSession = {
  user: { id: "admin_1", role: "institution_admin", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const studentSession = {
  user: { id: "stud_1", role: "student", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeParams = (competitionId: string) => ({
  params: Promise.resolve({ competitionId }),
});

const makeRequest = (method: "GET" | "PATCH" | "DELETE", body?: unknown) =>
  new Request("http://localhost/api/v1/competitions/comp_1", {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });

describe("GET /api/v1/competitions/[competitionId]", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with competition for member", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    getCompetitionForReader.mockResolvedValue({ id: "comp_1", status: "draft" });
    const response = await GET(makeRequest("GET"), makeParams("comp_1"));
    expect(response.status).toBe(200);
    expect(getCompetitionForReader).toHaveBeenCalledWith("admin_1", "institution_admin", "comp_1");
  });

  it("returns 404 when competition is missing or soft-deleted", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    getCompetitionForReader.mockRejectedValue(
      new CompetitionError("competition_not_found", 404, "Competition not found"),
    );
    const response = await GET(makeRequest("GET"), makeParams("comp_1"));
    expect(response.status).toBe(404);
  });

  it("returns 403 for non-member", async () => {
    requireAuthenticatedSession.mockResolvedValue(studentSession);
    getCompetitionForReader.mockRejectedValue(
      new AccessError("forbidden", 403, "Institution member access required"),
    );
    const response = await GET(makeRequest("GET"), makeParams("comp_1"));
    expect(response.status).toBe(403);
  });
});

describe("PATCH /api/v1/competitions/[competitionId]", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 on successful field update", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    updateCompetitionDraft.mockResolvedValue({ id: "comp_1", title: "Updated", status: "draft" });
    const response = await PATCH(makeRequest("PATCH", { title: "Updated" }), makeParams("comp_1"));
    expect(response.status).toBe(200);
    expect(updateCompetitionDraft).toHaveBeenCalledWith(
      "admin_1",
      "comp_1",
      expect.objectContaining({ title: "Updated" }),
    );
  });

  // Step 3.2: PATCH on a non-draft competition returns 409 competition_not_draft.
  it.each(["published", "archived"] as const)(
    "returns 409 competition_not_draft when target is %s",
    async (status) => {
      requireAuthenticatedSession.mockResolvedValue(adminSession);
      updateCompetitionDraft.mockRejectedValue(
        new CompetitionError(
          "competition_not_draft",
          409,
          `Cannot edit fields on a ${status} competition. Transition to draft first via PATCH /status.`,
          { fields: ["title"] },
        ),
      );
      const response = await PATCH(
        makeRequest("PATCH", { title: "Tampered Title 2026" }),
        makeParams("comp_1"),
      );
      const body = (await response.json()) as { error: { code: string } };
      expect(response.status).toBe(409);
      expect(body.error.code).toBe("competition_not_draft");
    },
  );

  it("silently strips status from patch and rejects when nothing else remains (400)", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    const response = await PATCH(
      makeRequest("PATCH", { status: "published" }),
      makeParams("comp_1"),
    );
    expect(response.status).toBe(400);
    expect(updateCompetitionDraft).not.toHaveBeenCalled();
  });

  it("silently strips API-blocked fields when valid editable fields are present", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    updateCompetitionDraft.mockResolvedValue({
      id: "comp_1",
      title: "Lomba Coding 2026",
      status: "draft",
    });
    const response = await PATCH(
      makeRequest("PATCH", { title: "Lomba Coding 2026", feeAmount: 999, isFeatured: true }),
      makeParams("comp_1"),
    );
    expect(response.status).toBe(200);
    expect(updateCompetitionDraft).toHaveBeenCalledWith(
      "admin_1",
      "comp_1",
      expect.objectContaining({ title: "Lomba Coding 2026" }),
    );
    const callPatch = updateCompetitionDraft.mock.calls[0]?.[2] as Record<string, unknown>;
    expect("feeAmount" in callPatch).toBe(false);
    expect("isFeatured" in callPatch).toBe(false);
  });

  it("returns 400 for invalid JSON", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    const response = await PATCH(
      new Request("http://localhost/api/v1/competitions/comp_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      makeParams("comp_1"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );
    const response = await PATCH(makeRequest("PATCH", { title: "X" }), makeParams("comp_1"));
    expect(response.status).toBe(401);
  });

  it("returns 409 on slug conflict", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    updateCompetitionDraft.mockRejectedValue(
      new CompetitionError("competition_slug_taken", 409, "slug taken"),
    );
    const response = await PATCH(
      makeRequest("PATCH", { slug: "taken-slug" }),
      makeParams("comp_1"),
    );
    expect(response.status).toBe(409);
  });
});

describe("DELETE /api/v1/competitions/[competitionId]", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 204 on successful soft-delete of draft", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    softDeleteCompetitionDraft.mockResolvedValue(undefined);
    const response = await DELETE(makeRequest("DELETE"), makeParams("comp_1"));
    expect(response.status).toBe(204);
    expect(softDeleteCompetitionDraft).toHaveBeenCalledWith("admin_1", "comp_1");
  });

  // C1 — carry-forward coverage: DELETE on non-draft returns 409.
  it.each(["published", "archived"] as const)(
    "returns 409 competition_delete_not_allowed when target is %s",
    async (status) => {
      requireAuthenticatedSession.mockResolvedValue(adminSession);
      softDeleteCompetitionDraft.mockRejectedValue(
        new CompetitionError(
          "competition_delete_not_allowed",
          409,
          `Only draft competitions can be deleted. Current status: ${status}.`,
        ),
      );
      const response = await DELETE(makeRequest("DELETE"), makeParams("comp_1"));
      const body = (await response.json()) as { error: { code: string } };
      expect(response.status).toBe(409);
      expect(body.error.code).toBe("competition_delete_not_allowed");
    },
  );

  it("returns 403 for non-member", async () => {
    requireAuthenticatedSession.mockResolvedValue(studentSession);
    softDeleteCompetitionDraft.mockRejectedValue(
      new AccessError("forbidden", 403, "Institution member access required"),
    );
    const response = await DELETE(makeRequest("DELETE"), makeParams("comp_1"));
    expect(response.status).toBe(403);
  });
});
