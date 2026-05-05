// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { CompetitionError } from "@/server/competitions/competition-core";

const { requireAuthenticatedSession, transitionCompetitionStatus } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  transitionCompetitionStatus: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/competitions/competition-service", () => ({ transitionCompetitionStatus }));

import { PATCH } from "@/app/api/v1/competitions/[competitionId]/status/route";

const adminSession = {
  user: { id: "admin_1", role: "institution_admin", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const staffSession = {
  user: { id: "staff_1", role: "institution_staff", email: "staff@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const studentSession = {
  user: { id: "stud_1", role: "student", email: "stud@example.com" },
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

const baseCompetition = {
  id: "comp_1",
  institutionId: "inst_1",
  status: "draft",
  publishedAt: null,
  archivedAt: null,
};

describe("PATCH /api/v1/competitions/[competitionId]/status", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 on draft → published with verified institution", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    transitionCompetitionStatus.mockResolvedValue({
      competition: {
        ...baseCompetition,
        status: "published",
        publishedAt: new Date().toISOString(),
      },
    });
    const response = await PATCH(makeRequest({ targetStatus: "published" }), makeParams("comp_1"));
    expect(response.status).toBe(200);
    expect(transitionCompetitionStatus).toHaveBeenCalledWith("admin_1", "comp_1", "published");
  });

  it("returns 422 INSTITUTION_NOT_VERIFIED when publishing an unverified institution", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    transitionCompetitionStatus.mockRejectedValue(
      new CompetitionError(
        "competition_institution_not_verified",
        422,
        "Institution must be verified by platform ops before publishing competitions",
      ),
    );
    const response = await PATCH(makeRequest({ targetStatus: "published" }), makeParams("comp_1"));
    const body = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("competition_institution_not_verified");
  });

  it("returns 403 when institution_staff attempts to publish", async () => {
    requireAuthenticatedSession.mockResolvedValue(staffSession);
    transitionCompetitionStatus.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_admin access required"),
    );
    const response = await PATCH(makeRequest({ targetStatus: "published" }), makeParams("comp_1"));
    expect(response.status).toBe(403);
  });

  it("returns 403 for non-member student", async () => {
    requireAuthenticatedSession.mockResolvedValue(studentSession);
    transitionCompetitionStatus.mockRejectedValue(
      new AccessError("forbidden", 403, "Institution member access required"),
    );
    const response = await PATCH(makeRequest({ targetStatus: "published" }), makeParams("comp_1"));
    expect(response.status).toBe(403);
  });

  it("returns 422 on invalid transition (archived → draft)", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    transitionCompetitionStatus.mockRejectedValue(
      new CompetitionError(
        "competition_invalid_transition",
        422,
        "Cannot transition competition from 'archived' to 'draft'",
      ),
    );
    const response = await PATCH(makeRequest({ targetStatus: "draft" }), makeParams("comp_1"));
    expect(response.status).toBe(422);
  });

  it("returns 422 on publish-validation failure (missing fields)", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    transitionCompetitionStatus.mockRejectedValue(
      new CompetitionError(
        "competition_publish_validation_failed",
        422,
        "Cannot publish: missing required fields: mode",
        { fields: ["mode"] },
      ),
    );
    const response = await PATCH(makeRequest({ targetStatus: "published" }), makeParams("comp_1"));
    const body = (await response.json()) as {
      error: { code: string; details?: { fields?: string[] } };
    };
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("competition_publish_validation_failed");
    expect(body.error.details?.fields).toEqual(["mode"]);
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );
    const response = await PATCH(makeRequest({ targetStatus: "published" }), makeParams("comp_1"));
    expect(response.status).toBe(401);
  });

  it("returns 400 for invalid targetStatus", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    const response = await PATCH(makeRequest({ targetStatus: "live" }), makeParams("comp_1"));
    expect(response.status).toBe(400);
    expect(transitionCompetitionStatus).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    const request = new Request("http://localhost", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const response = await PATCH(request, makeParams("comp_1"));
    expect(response.status).toBe(400);
  });
});
