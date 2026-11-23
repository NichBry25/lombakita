// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAuthenticatedSession, requireAdminInstitutionBySlug, unpublishResult } = vi.hoisted(
  () => ({
    requireAuthenticatedSession: vi.fn(),
    requireAdminInstitutionBySlug: vi.fn(),
    unpublishResult: vi.fn(),
  }),
);

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ requireAdminInstitutionBySlug }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/participants/result-service", async (importActual) => {
  const actual = await importActual<typeof import("@/server/participants/result-service")>();
  return { ...actual, unpublishResult };
});

import { POST } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/registrations/[registrationId]/result/unpublish/route";

const staffSession = {
  user: { id: "user_1", role: "recruiter", email: "staff@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const makeParams = () => ({
  params: Promise.resolve({
    institutionSlug: "lk-univ",
    competitionId: "comp-1",
    registrationId: "reg-1",
  }),
});

const draftRow = {
  id: "res_1",
  registrationId: "reg-1",
  competitionId: "comp-1",
  resultStatus: "draft" as const,
  resultLabel: "Juara 1",
  resultNotes: null,
  publishedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("POST .../result/unpublish", () => {
  afterEach(() => vi.clearAllMocks());

  it("passes the session user id as the actor user id and the membership id as the membership id", async () => {
    requireAuthenticatedSession.mockResolvedValue(staffSession);
    requireAdminInstitutionBySlug.mockResolvedValue({
      institutionId: "inst_1",
      actorMembershipId: "membership_1",
    });
    unpublishResult.mockResolvedValue(draftRow);

    const res = await POST(new Request("http://localhost/...", { method: "POST" }), makeParams());

    expect(res.status).toBe(200);
    expect(unpublishResult).toHaveBeenCalledWith(
      "inst_1",
      "comp-1",
      "reg-1",
      "user_1",
      "membership_1",
      expect.anything(),
    );
  });

  it("returns 403 with result_own_place when the service refuses the actor's own entry", async () => {
    requireAuthenticatedSession.mockResolvedValue(staffSession);
    requireAdminInstitutionBySlug.mockResolvedValue({
      institutionId: "inst_1",
      actorMembershipId: "membership_1",
    });
    const { ResultError } = await import("@/server/participants/result-service");
    unpublishResult.mockRejectedValue(
      new ResultError("result_own_place", 403, "Anda tidak dapat mengubah"),
    );

    const res = await POST(new Request("http://localhost/...", { method: "POST" }), makeParams());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("result_own_place");
  });
});
