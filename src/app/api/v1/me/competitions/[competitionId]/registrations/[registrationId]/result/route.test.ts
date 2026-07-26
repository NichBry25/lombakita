// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, getPublishedResultForCandidate } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  getPublishedResultForCandidate: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/participants/result-service", async (importActual) => {
  const actual = await importActual<typeof import("@/server/participants/result-service")>();
  return { ...actual, getPublishedResultForCandidate };
});

import { GET } from "@/app/api/v1/me/competitions/[competitionId]/registrations/[registrationId]/result/route";

const candidateSession = {
  user: {
    id: "cand_1",
    role: "candidate",
    email: "cand@example.com",
    verifiedRoles: ["candidate"],
  },
  expires: "2099-01-01T00:00:00.000Z",
};

const makeParams = (competitionId = "comp-1", registrationId = "reg-1") => ({
  params: Promise.resolve({ competitionId, registrationId }),
});

const makeReq = () => new Request("http://localhost/...");

describe("GET /api/v1/me/competitions/[competitionId]/registrations/[registrationId]/result", () => {
  afterEach(() => vi.clearAllMocks());

  it("(a) returns 200 with resultLabel and resultNotes when result is published and belongs to candidate", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getPublishedResultForCandidate.mockResolvedValue({
      resultLabel: "Finalis",
      resultNotes: "Selamat!",
    });

    const res = await GET(makeReq(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.resultLabel).toBe("Finalis");
    expect(body.result.resultNotes).toBe("Selamat!");
  });

  it("(b) returns 404 when result is unpublished (service returns null)", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getPublishedResultForCandidate.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams());
    expect(res.status).toBe(404);
  });

  it("(c) returns 404 for IDOR — stranger registrationId (service returns null)", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    // service returns null for stranger's registration — no info leak
    getPublishedResultForCandidate.mockResolvedValue(null);

    const res = await GET(makeReq(), makeParams("comp-1", "stranger-reg"));
    expect(res.status).toBe(404);
  });

  it("(d) returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const res = await GET(makeReq(), makeParams());
    expect(res.status).toBe(401);
  });

  it("(e) response body does not include result_status or published_at", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getPublishedResultForCandidate.mockResolvedValue({
      resultLabel: "Winner",
      resultNotes: null,
    });

    const res = await GET(makeReq(), makeParams());
    const body = await res.json();
    const keys = Object.keys(body.result ?? {});
    expect(keys).not.toContain("resultStatus");
    expect(keys).not.toContain("publishedAt");
    expect(keys).not.toContain("internalReviewStatus");
    expect(keys).not.toContain("internalNotes");
  });
});
