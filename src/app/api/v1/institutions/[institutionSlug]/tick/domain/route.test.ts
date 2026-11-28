// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { VerificationError } from "@/server/institution-verification/verification-core";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

const { requireSessionRole, tickByOrganizationDomain } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  tickByOrganizationDomain: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/institution-verification/tick-service", () => ({ tickByOrganizationDomain }));

import { POST } from "@/app/api/v1/institutions/[institutionSlug]/tick/domain/route";

const recruiterSession = {
  user: { id: "user_1", role: "recruiter", email: "owner@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const press = (expectedUserId: string) =>
  POST(
    new Request("http://localhost", {
      method: "POST",
      headers: { [SESSION_USER_HEADER]: expectedUserId },
    }) as never,
    { params: Promise.resolve({ institutionSlug: "pt-contoh" }) },
  );

describe("POST /api/v1/institutions/[institutionSlug]/tick/domain", () => {
  afterEach(() => vi.clearAllMocks());

  it("refuses a session without the recruiter role before the service", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("forbidden", 403, "Insufficient role permissions"),
    );

    const response = await press("user_1");

    expect(response.status).toBe(403);
    expect(tickByOrganizationDomain).not.toHaveBeenCalled();
  });

  it("refuses a mismatched expected user before the service", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);

    const response = await press("someone_else");
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("session_user_mismatch");
    expect(tickByOrganizationDomain).not.toHaveBeenCalled();
  });

  it("answers a refusal with its code, status and cause", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    tickByOrganizationDomain.mockRejectedValue(
      new VerificationError(
        "institution_tick_path_a_closed",
        409,
        "This workspace's tick was removed by staff or by a name proof rule, so it can only return through documents or a staff decision",
        { cause: "staff", closedInstitutionId: "inst_1" },
      ),
    );

    const response = await press("user_1");
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("institution_tick_path_a_closed");
    expect(body.error.details.cause).toBe("staff");
  });

  it("answers 200 with the institution and no tick domain", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    const institution = { id: "inst_1", verificationStatus: "verified", tickPath: "domain" };
    tickByOrganizationDomain.mockResolvedValue(institution);

    const response = await press("user_1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.institution).toEqual(institution);
    expect(tickByOrganizationDomain).toHaveBeenCalledWith("user_1", "pt-contoh");
  });
});
