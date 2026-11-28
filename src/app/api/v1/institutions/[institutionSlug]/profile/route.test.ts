// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { VerificationError } from "@/server/institution-verification/verification-core";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

const {
  requireAuthenticatedSession,
  getInstitutionProfileForOwnerBySlug,
  updateInstitutionProfileForOwnerBySlug,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  getInstitutionProfileForOwnerBySlug: vi.fn(),
  updateInstitutionProfileForOwnerBySlug: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  getInstitutionProfileForOwnerBySlug,
  updateInstitutionProfileForOwnerBySlug,
}));

import { PATCH } from "@/app/api/v1/institutions/[institutionSlug]/profile/route";

const sessionFixture = {
  user: { id: "user_1", role: "recruiter", email: "owner@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const patchProfile = (expectedUserId: string, body: Record<string, unknown>) =>
  PATCH(
    new Request("http://localhost", {
      method: "PATCH",
      headers: { "content-type": "application/json", [SESSION_USER_HEADER]: expectedUserId },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ institutionSlug: "pt-contoh" }) },
  );

describe("PATCH /api/v1/institutions/[institutionSlug]/profile", () => {
  afterEach(() => vi.clearAllMocks());

  it("refuses a mismatched expected user before updating the profile", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);

    const response = await patchProfile("someone_else", { websiteUrl: "https://acme.example" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("session_user_mismatch");
    expect(updateInstitutionProfileForOwnerBySlug).not.toHaveBeenCalled();
  });

  it("answers an unconfirmed tick removal with 409", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateInstitutionProfileForOwnerBySlug.mockRejectedValue(
      new VerificationError(
        "institution_tick_removal_unconfirmed",
        409,
        "This change removes the workspace tick. Send acknowledgeTickRemoval true to confirm it",
      ),
    );

    const response = await patchProfile("user_1", { websiteUrl: "https://other.example" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("institution_tick_removal_unconfirmed");
  });

  it("answers a tick write conflict with 409", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateInstitutionProfileForOwnerBySlug.mockRejectedValue(
      new VerificationError(
        "verification_transition_conflict",
        409,
        "This institution's verification status changed while you were deciding. Reload and try again",
      ),
    );

    const response = await patchProfile("user_1", {
      websiteUrl: "https://other.example",
      acknowledgeTickRemoval: true,
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("verification_transition_conflict");
  });
});
