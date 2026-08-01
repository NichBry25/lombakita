// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { CompetitionError } from "@/server/competitions/competition-core";

const {
  requireAuthenticatedSession,
  assertCompetitionInInstitution,
  cancelCompetitionForInsufficientParticipation,
  confirmCompetitionWillProceed,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  assertCompetitionInInstitution: vi.fn(),
  cancelCompetitionForInsufficientParticipation: vi.fn(),
  confirmCompetitionWillProceed: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/competitions/competition-service", () => ({
  assertCompetitionInInstitution,
}));
vi.mock("@/server/competitions/competition-participation-service", () => ({
  cancelCompetitionForInsufficientParticipation,
  confirmCompetitionWillProceed,
}));

import { POST } from "./route";

const session = {
  user: { id: "owner_1", role: "recruiter", email: "owner@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const request = (decision: unknown) =>
  new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });

const context = (institutionSlug = "lk-univ") => ({
  params: Promise.resolve({ institutionSlug, competitionId: "comp_1" }),
});

describe("POST .../participation-decision", () => {
  afterEach(() => vi.clearAllMocks());

  it("cancels through the owner-scoped service", async () => {
    requireAuthenticatedSession.mockResolvedValue(session);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    cancelCompetitionForInsufficientParticipation.mockResolvedValue({
      competition: { id: "comp_1", status: "published", cancelledAt: new Date() },
      cancelledRegistrationCount: 8,
    });

    const response = await POST(request("cancel"), context("  LK-Univ "));

    expect(response.status).toBe(200);
    expect(assertCompetitionInInstitution).toHaveBeenCalledWith("lk-univ", "comp_1");
    expect(cancelCompetitionForInsufficientParticipation).toHaveBeenCalledWith("owner_1", "comp_1");
    expect(confirmCompetitionWillProceed).not.toHaveBeenCalled();
  });

  it("confirms proceeding below the minimum", async () => {
    requireAuthenticatedSession.mockResolvedValue(session);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    confirmCompetitionWillProceed.mockResolvedValue({
      competition: { id: "comp_1", status: "published", participationConfirmedAt: new Date() },
      cancelledRegistrationCount: 0,
    });

    const response = await POST(request("proceed"), context());

    expect(response.status).toBe(200);
    expect(confirmCompetitionWillProceed).toHaveBeenCalledWith("owner_1", "comp_1");
    expect(cancelCompetitionForInsufficientParticipation).not.toHaveBeenCalled();
  });

  it("rejects an unknown decision before invoking a service", async () => {
    requireAuthenticatedSession.mockResolvedValue(session);
    assertCompetitionInInstitution.mockResolvedValue(undefined);

    const response = await POST(request("later"), context());
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("competition_invalid_payload");
    expect(cancelCompetitionForInsufficientParticipation).not.toHaveBeenCalled();
    expect(confirmCompetitionWillProceed).not.toHaveBeenCalled();
  });

  it("returns 409 when the minimum has already been met", async () => {
    requireAuthenticatedSession.mockResolvedValue(session);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    cancelCompetitionForInsufficientParticipation.mockRejectedValue(
      new CompetitionError(
        "competition_participation_decision_unavailable",
        409,
        "The competition is already confirmed and can no longer be cancelled",
      ),
    );

    const response = await POST(request("cancel"), context());

    expect(response.status).toBe(409);
  });

  it("returns 403 when the caller is not the institution owner", async () => {
    requireAuthenticatedSession.mockResolvedValue(session);
    assertCompetitionInInstitution.mockResolvedValue(undefined);
    cancelCompetitionForInsufficientParticipation.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner access required"),
    );

    const response = await POST(request("cancel"), context());

    expect(response.status).toBe(403);
  });
});
