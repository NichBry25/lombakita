// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const {
  requireAuthenticatedSession,
  requireAdminInstitutionBySlug,
  getResultForInstitution,
  upsertResultDraft,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  requireAdminInstitutionBySlug: vi.fn(),
  getResultForInstitution: vi.fn(),
  upsertResultDraft: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ requireAdminInstitutionBySlug }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/participants/result-service", async (importActual) => {
  const actual = await importActual<typeof import("@/server/participants/result-service")>();
  return { ...actual, getResultForInstitution, upsertResultDraft };
});

import {
  GET,
  PUT,
} from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/registrations/[registrationId]/result/route";

const ownerSession = {
  user: { id: "owner_1", role: "recruiter", email: "owner@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const makeParams = () => ({
  params: Promise.resolve({
    institutionSlug: "lk-univ",
    competitionId: "comp-1",
    registrationId: "reg-1",
  }),
});

const draftResult = {
  id: "res_1",
  registrationId: "reg-1",
  competitionId: "comp-1",
  resultStatus: "draft" as const,
  resultLabel: null,
  resultNotes: null,
  publishedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  registrationType: "individual" as const,
  teamName: null,
  activeMemberCount: null,
};

describe("GET .../result", () => {
  afterEach(() => vi.clearAllMocks());

  it("(a) returns 200 with result context for institution_owner", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    getResultForInstitution.mockResolvedValue(draftResult);

    const req = new Request("http://localhost/...");
    const res = await GET(req, makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.resultStatus).toBe("draft");
  });

  it("(b) returns 404 when cross-institution registration (getResultForInstitution returns null)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    getResultForInstitution.mockResolvedValue(null);

    const req = new Request("http://localhost/...");
    const res = await GET(req, makeParams());
    expect(res.status).toBe(404);
  });

  it("(c) returns 403 for institution_member (CCR-09)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner or institution_staff required"),
    );

    const req = new Request("http://localhost/...");
    const res = await GET(req, makeParams());
    expect(res.status).toBe(403);
  });

  it("(d) returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const req = new Request("http://localhost/...");
    const res = await GET(req, makeParams());
    expect(res.status).toBe(401);
  });
});

describe("PUT .../result", () => {
  afterEach(() => vi.clearAllMocks());

  it("(e) returns 200 on successful draft upsert", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    upsertResultDraft.mockResolvedValue({ ...draftResult, resultLabel: "Juara 1" });

    const req = new Request("http://localhost/...", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resultLabel: "Juara 1" }),
    });
    const res = await PUT(req, makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.resultLabel).toBe("Juara 1");
  });

  it("(f) returns 409 when result is already published", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    const { ResultError } = await import("@/server/participants/result-service");
    upsertResultDraft.mockRejectedValue(
      new ResultError("result_already_published", 409, "Result is already published"),
    );

    const req = new Request("http://localhost/...", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resultLabel: "new" }),
    });
    const res = await PUT(req, makeParams());
    expect(res.status).toBe(409);
  });

  it("(g) returns 400 for an unsupported field", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });

    const req = new Request("http://localhost/...", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ badField: "x" }),
    });
    const res = await PUT(req, makeParams());
    expect(res.status).toBe(400);
    expect(upsertResultDraft).not.toHaveBeenCalled();
  });
});
