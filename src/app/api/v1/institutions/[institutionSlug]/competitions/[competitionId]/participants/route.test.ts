// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, requireAdminInstitutionBySlug, listCompetitionParticipants } =
  vi.hoisted(() => ({
    requireAuthenticatedSession: vi.fn(),
    requireAdminInstitutionBySlug: vi.fn(),
    listCompetitionParticipants: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ requireAdminInstitutionBySlug }));
vi.mock("@/server/participants/participant-service", () => ({ listCompetitionParticipants }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));

import { GET } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/participants/route";

const ownerSession = {
  user: { id: "owner_1", role: "recruiter", email: "owner@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const emptyResult = {
  participants: [],
  pagination: { page: 1, limit: 20, totalPages: 0, totalCount: 0 },
  counts: {
    total: 0,
    confirmed: 0,
    pending: 0,
    cancelled: 0,
    withSubmissions: 0,
    withFinalizedSubmissions: 0,
  },
};

const someResult = {
  participants: [
    {
      registrationId: "reg_1",
      registrationType: "individual",
      status: "confirmed",
      registeredAt: "2026-05-01T00:00:00.000Z",
      candidate: { userId: "u_1", displayName: "Andi", username: "andi" },
      team: null,
      submission: null,
    },
  ],
  pagination: { page: 1, limit: 20, totalPages: 1, totalCount: 1 },
  counts: {
    total: 1,
    confirmed: 1,
    pending: 0,
    cancelled: 0,
    withSubmissions: 0,
    withFinalizedSubmissions: 0,
  },
};

const makeGet = (institutionSlug: string, competitionId: string, qs = "") =>
  new Request(
    `http://localhost/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/participants${qs}`,
  );

const makeParams = (institutionSlug: string, competitionId: string) => ({
  params: Promise.resolve({ institutionSlug, competitionId }),
});

describe("GET /api/v1/institutions/[institutionSlug]/competitions/[competitionId]/participants", () => {
  afterEach(() => vi.clearAllMocks());

  it("(a) returns 200 with correct shape for authorized institution_owner", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    listCompetitionParticipants.mockResolvedValue(someResult);

    const response = await GET(makeGet("lk-univ", "comp-1"), makeParams("lk-univ", "comp-1"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.participants)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(body.counts).toBeDefined();
  });

  it("(b) returns 200 for institution_staff (same access level as owner)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    listCompetitionParticipants.mockResolvedValue(someResult);

    const response = await GET(makeGet("lk-univ", "comp-1"), makeParams("lk-univ", "comp-1"));
    expect(response.status).toBe(200);
  });

  it("(c) returns 403 for institution_member", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner or institution_staff access required"),
    );

    const response = await GET(makeGet("lk-univ", "comp-1"), makeParams("lk-univ", "comp-1"));
    expect(response.status).toBe(403);
  });

  it("(d) returns 401 for unauthenticated session", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await GET(makeGet("lk-univ", "comp-1"), makeParams("lk-univ", "comp-1"));
    expect(response.status).toBe(401);
  });

  it("(e) returns 200 with empty result for competitionId belonging to a different institution", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    listCompetitionParticipants.mockResolvedValue(emptyResult);

    const response = await GET(
      makeGet("lk-univ", "other-inst-comp"),
      makeParams("lk-univ", "other-inst-comp"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.participants).toHaveLength(0);
    expect(body.counts.total).toBe(0);
  });

  it("(f) clamps limit to 50 when caller sends limit=200", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    listCompetitionParticipants.mockResolvedValue(emptyResult);

    await GET(makeGet("lk-univ", "comp-1", "?limit=200"), makeParams("lk-univ", "comp-1"));
    expect(listCompetitionParticipants).toHaveBeenCalledWith(
      "inst_1",
      "comp-1",
      expect.objectContaining({ limit: 50 }),
      expect.anything(),
    );
  });
});
