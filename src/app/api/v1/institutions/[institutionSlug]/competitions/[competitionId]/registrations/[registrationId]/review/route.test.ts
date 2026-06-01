// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, requireAdminInstitutionBySlug, updateRegistrationReview } =
  vi.hoisted(() => ({
    requireAuthenticatedSession: vi.fn(),
    requireAdminInstitutionBySlug: vi.fn(),
    updateRegistrationReview: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-members/member-service", () => ({ requireAdminInstitutionBySlug }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

// Keep the real parser + ReviewError + toReviewErrorResponse; only the DB writer is mocked.
vi.mock("@/server/participants/review-service", async (importActual) => {
  const actual = await importActual<typeof import("@/server/participants/review-service")>();
  return { ...actual, updateRegistrationReview };
});

import { PATCH } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/registrations/[registrationId]/review/route";

const ownerSession = {
  user: { id: "owner_1", role: "recruiter", email: "owner@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const makePatch = (body: unknown) =>
  new Request(
    "http://localhost/api/v1/institutions/lk-univ/competitions/comp-1/registrations/reg-1/review",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

const makeParams = () => ({
  params: Promise.resolve({
    institutionSlug: "lk-univ",
    competitionId: "comp-1",
    registrationId: "reg-1",
  }),
});

describe("PATCH /api/v1/institutions/[institutionSlug]/competitions/[competitionId]/registrations/[registrationId]/review", () => {
  afterEach(() => vi.clearAllMocks());

  it("(f) returns 200 for institution_owner with the updated review fields", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    updateRegistrationReview.mockResolvedValue({
      internalReviewStatus: "shortlisted",
      internalNotes: null,
    });

    const res = await PATCH(makePatch({ internalReviewStatus: "shortlisted" }), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.internalReviewStatus).toBe("shortlisted");
  });

  it("(g) returns 200 for institution_staff (same gate)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    updateRegistrationReview.mockResolvedValue({
      internalReviewStatus: "under_review",
      internalNotes: "ok",
    });

    const res = await PATCH(makePatch({ internalNotes: "ok" }), makeParams());
    expect(res.status).toBe(200);
  });

  it("(h) returns 403 for institution_member (CCR-09)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner or institution_staff access required"),
    );

    const res = await PATCH(makePatch({ internalReviewStatus: "rejected" }), makeParams());
    expect(res.status).toBe(403);
  });

  it("(i) returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const res = await PATCH(makePatch({ internalReviewStatus: "rejected" }), makeParams());
    expect(res.status).toBe(401);
  });

  it("(j) returns 422 for an invalid status value", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });

    const res = await PATCH(makePatch({ internalReviewStatus: "bogus" }), makeParams());
    expect(res.status).toBe(422);
    expect(updateRegistrationReview).not.toHaveBeenCalled();
  });

  it("(k) returns 400 for an empty body (no fields)", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });

    const res = await PATCH(makePatch({}), makeParams());
    expect(res.status).toBe(400);
    expect(updateRegistrationReview).not.toHaveBeenCalled();
  });

  it("(l) returns 404 when the service reports a cross-institution / unknown registration", async () => {
    requireAuthenticatedSession.mockResolvedValue(ownerSession);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_1" });
    const { ReviewError } = await import("@/server/participants/review-service");
    updateRegistrationReview.mockRejectedValue(
      new ReviewError("review_registration_not_found", 404, "Registration not found"),
    );

    const res = await PATCH(makePatch({ internalReviewStatus: "rejected" }), makeParams());
    expect(res.status).toBe(404);
  });
});
