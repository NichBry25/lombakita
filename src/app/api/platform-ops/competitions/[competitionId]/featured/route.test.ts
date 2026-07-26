// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, setFeaturedPlacement, FeaturedPlacementError } = vi.hoisted(() => {
  class FeaturedPlacementError extends Error {
    constructor(
      public readonly code: "competition_not_found" | "competition_not_published",
      public readonly status: 404 | 409,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    requireSessionRole: vi.fn(),
    setFeaturedPlacement: vi.fn(),
    FeaturedPlacementError,
  };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/featured/featured-placement-service", () => ({
  setFeaturedPlacement,
  FeaturedPlacementError,
  toFeaturedPlacementErrorResponse: (e: { code: string; message: string }) => ({
    error: { code: e.code, message: e.message },
  }),
}));

import { PATCH } from "./route";

const opsSession = {
  user: { id: "ops_1", role: "platform_ops", email: "ops@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = (body: unknown) =>
  new Request("http://localhost", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const makeParams = (competitionId: string) => ({
  params: Promise.resolve({ competitionId }),
});

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  setFeaturedPlacement.mockResolvedValue({ isFeatured: true, featuredOrder: 1 });
});

afterEach(() => vi.clearAllMocks());

describe("PATCH /api/platform-ops/competitions/[competitionId]/featured", () => {
  it("returns 200 with result for published competition", async () => {
    const res = await PATCH(
      makeRequest({ isFeatured: true, featuredOrder: 1 }),
      makeParams("comp_1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ isFeatured: true, featuredOrder: 1 });
  });

  it("returns 403 when session is not platform_ops (candidate)", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "Forbidden"));
    const res = await PATCH(makeRequest({ isFeatured: true }), makeParams("comp_1"));
    expect(res.status).toBe(403);
  });

  it("returns 403 when session is institution_owner (not platform_ops)", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "Forbidden"));
    const res = await PATCH(makeRequest({ isFeatured: true }), makeParams("comp_1"));
    expect(res.status).toBe(403);
  });

  it("returns 409 when competition is not published (draft)", async () => {
    setFeaturedPlacement.mockRejectedValueOnce(
      new FeaturedPlacementError(
        "competition_not_published",
        409,
        "Only published competitions can be featured",
      ),
    );
    const res = await PATCH(makeRequest({ isFeatured: true }), makeParams("comp_draft"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("competition_not_published");
  });

  it("returns 409 when competition is archived (not published)", async () => {
    setFeaturedPlacement.mockRejectedValueOnce(
      new FeaturedPlacementError(
        "competition_not_published",
        409,
        "Only published competitions can be featured",
      ),
    );
    const res = await PATCH(makeRequest({ isFeatured: true }), makeParams("comp_archived"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("competition_not_published");
  });

  it("returns 404 when competition is not found", async () => {
    setFeaturedPlacement.mockRejectedValueOnce(
      new FeaturedPlacementError("competition_not_found", 404, "Competition not found"),
    );
    const res = await PATCH(makeRequest({ isFeatured: false }), makeParams("comp_missing"));
    expect(res.status).toBe(404);
  });

  it("returns 400 when isFeatured is missing from body", async () => {
    const res = await PATCH(makeRequest({ featuredOrder: 1 }), makeParams("comp_1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when isFeatured is not a boolean", async () => {
    const res = await PATCH(makeRequest({ isFeatured: "yes" }), makeParams("comp_1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when featuredOrder is not an integer", async () => {
    const res = await PATCH(
      makeRequest({ isFeatured: true, featuredOrder: 1.5 }),
      makeParams("comp_1"),
    );
    expect(res.status).toBe(400);
  });

  it("accepts null featuredOrder", async () => {
    setFeaturedPlacement.mockResolvedValueOnce({ isFeatured: true, featuredOrder: null });
    const res = await PATCH(
      makeRequest({ isFeatured: true, featuredOrder: null }),
      makeParams("comp_1"),
    );
    expect(res.status).toBe(200);
  });

  it("accepts omitted featuredOrder (defaults to null)", async () => {
    setFeaturedPlacement.mockResolvedValueOnce({ isFeatured: false, featuredOrder: null });
    const res = await PATCH(makeRequest({ isFeatured: false }), makeParams("comp_1"));
    expect(res.status).toBe(200);
  });
});
