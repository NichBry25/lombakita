// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { CompetitionError } from "@/server/competitions/competition-core";

const {
  requireAuthenticatedSession,
  transitionCompetitionStatus,
  unpublishCompetition,
  assertCompetitionInInstitution,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  transitionCompetitionStatus: vi.fn(),
  unpublishCompetition: vi.fn(),
  assertCompetitionInInstitution: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/competitions/competition-service", () => ({
  transitionCompetitionStatus,
  unpublishCompetition,
  assertCompetitionInInstitution,
}));

import { POST as PUBLISH } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
import { POST as UNPUBLISH } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/unpublish/route";

const adminSession = {
  user: { id: "admin_1", role: "recruiter", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const staffSession = {
  user: { id: "staff_1", role: "recruiter", email: "staff@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const studentSession = {
  user: { id: "stud_1", role: "candidate", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = () =>
  new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

const makeParams = (institutionSlug: string, competitionId: string) => ({
  params: Promise.resolve({ institutionSlug, competitionId }),
});

const baseCompetition = {
  id: "comp_1",
  institutionId: "inst_1",
  status: "published",
  publishedAt: new Date().toISOString(),
};

describe("POST /api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 on draft → published with verified institution", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    transitionCompetitionStatus.mockResolvedValue({ competition: baseCompetition });
    const response = await PUBLISH(makeRequest(), makeParams("lk-univ", "comp_1"));
    expect(response.status).toBe(200);
    expect(assertCompetitionInInstitution).toHaveBeenCalledWith("lk-univ", "comp_1");
    expect(transitionCompetitionStatus).toHaveBeenCalledWith("admin_1", "comp_1", "published");
  });

  it("normalizes institution slug to lowercase before guard lookup", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    transitionCompetitionStatus.mockResolvedValue({ competition: baseCompetition });
    await PUBLISH(makeRequest(), makeParams("  LK-Univ  ", "comp_1"));
    expect(assertCompetitionInInstitution).toHaveBeenCalledWith("lk-univ", "comp_1");
  });

  it("returns 404 when competition does not belong to the institution slug", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    assertCompetitionInInstitution.mockRejectedValue(
      new CompetitionError("competition_not_found", 404, "Competition not found"),
    );
    const response = await PUBLISH(makeRequest(), makeParams("other-univ", "comp_1"));
    expect(response.status).toBe(404);
    expect(transitionCompetitionStatus).not.toHaveBeenCalled();
  });

  it("returns 422 with structured failures on incomplete draft", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    transitionCompetitionStatus.mockRejectedValue(
      new CompetitionError(
        "competition_publish_validation_failed",
        422,
        "Cannot publish: 2 validation issue(s) — see details.failures",
        {
          fields: ["mode", "category"],
          failures: [
            { field: "mode", code: "missing", message: "mode is required to publish" },
            { field: "category", code: "missing", message: "category is required to publish" },
          ],
        },
      ),
    );
    const response = await PUBLISH(makeRequest(), makeParams("lk-univ", "comp_1"));
    const body = (await response.json()) as {
      error: { code: string; details?: { failures?: { field: string }[] } };
    };
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("competition_publish_validation_failed");
    expect(body.error.details?.failures?.map((f) => f.field)).toEqual(["mode", "category"]);
  });

  it("returns 422 when institution is not verified", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    transitionCompetitionStatus.mockRejectedValue(
      new CompetitionError(
        "competition_institution_not_verified",
        422,
        "Institution must be verified by platform ops before publishing competitions",
      ),
    );
    const response = await PUBLISH(makeRequest(), makeParams("lk-univ", "comp_1"));
    expect(response.status).toBe(422);
  });

  it("returns 403 when institution_staff attempts to publish", async () => {
    requireAuthenticatedSession.mockResolvedValue(staffSession);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    transitionCompetitionStatus.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner access required"),
    );
    const response = await PUBLISH(makeRequest(), makeParams("lk-univ", "comp_1"));
    expect(response.status).toBe(403);
  });

  it("returns 403 for non-member student", async () => {
    requireAuthenticatedSession.mockResolvedValue(studentSession);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    transitionCompetitionStatus.mockRejectedValue(
      new AccessError("forbidden", 403, "Institution owner/staff access required"),
    );
    const response = await PUBLISH(makeRequest(), makeParams("lk-univ", "comp_1"));
    expect(response.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );
    const response = await PUBLISH(makeRequest(), makeParams("lk-univ", "comp_1"));
    expect(response.status).toBe(401);
    expect(assertCompetitionInInstitution).not.toHaveBeenCalled();
  });
});

describe("POST .../unpublish", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 on published → draft (cascade-cancel)", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    unpublishCompetition.mockResolvedValue({
      competition: { ...baseCompetition, status: "draft" },
      cancelledCount: 3,
    });
    const response = await UNPUBLISH(makeRequest(), makeParams("lk-univ", "comp_1"));
    expect(response.status).toBe(200);
    expect(unpublishCompetition).toHaveBeenCalledWith("admin_1", "comp_1");
  });

  it("returns 422 when the competition is not published", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    unpublishCompetition.mockRejectedValue(
      new CompetitionError(
        "competition_invalid_transition",
        422,
        "Cannot unpublish a competition in 'draft' status",
      ),
    );
    const response = await UNPUBLISH(makeRequest(), makeParams("lk-univ", "comp_1"));
    expect(response.status).toBe(422);
  });

  it("returns 403 when institution_staff attempts to unpublish", async () => {
    requireAuthenticatedSession.mockResolvedValue(staffSession);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    unpublishCompetition.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner access required"),
    );
    const response = await UNPUBLISH(makeRequest(), makeParams("lk-univ", "comp_1"));
    expect(response.status).toBe(403);
  });
});
