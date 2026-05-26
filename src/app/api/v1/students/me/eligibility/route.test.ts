// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { EligibilityInputError } from "@/server/eligibility/eligibility-core";

const {
  requireSessionRole,
  getStudentEligibilityProfile,
  checkStudentEligibility,
  updateStudentEligibilityProfile,
} = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  getStudentEligibilityProfile: vi.fn(),
  checkStudentEligibility: vi.fn(),
  updateStudentEligibilityProfile: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/eligibility/eligibility-service", () => ({
  getStudentEligibilityProfile,
  checkStudentEligibility,
  updateStudentEligibilityProfile,
}));

import { GET, PATCH } from "./route";

const candidateSession = {
  user: { id: "stud_1", role: "candidate", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const eligibilityResult = {
  status: "eligible" as const,
  reasons: [],
  checkedAt: new Date("2026-05-09T12:00:00.000Z"),
};

const profileShell = {
  userId: "stud_1",
  dateOfBirth: "2002-03-21",
  enrollmentStatus: "enrolled" as const,
  educationLevel: "S1" as const,
  universityName: "Universitas Indonesia",
  studentIdNumber: "1906345678",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const makeGetRequest = () =>
  new Request("http://localhost/api/v1/students/me/eligibility", { method: "GET" });

const makePatchRequest = (body: unknown) =>
  new Request("http://localhost/api/v1/students/me/eligibility", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("GET /api/v1/students/me/eligibility", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with profile and eligibility for an authenticated student", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getStudentEligibilityProfile.mockResolvedValue(profileShell);
    checkStudentEligibility.mockResolvedValue(eligibilityResult);

    const res = await GET(makeGetRequest() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.profile.userId).toBe("stud_1");
    expect(body.eligibility.status).toBe("eligible");
    expect(getStudentEligibilityProfile).toHaveBeenCalledWith("stud_1");
    expect(checkStudentEligibility).toHaveBeenCalledWith("stud_1");
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await GET(makeGetRequest() as never);
    expect(res.status).toBe(401);
    expect(getStudentEligibilityProfile).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is recruiter (not a candidate)", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));

    const res = await GET(makeGetRequest() as never);
    expect(res.status).toBe(403);
    expect(checkStudentEligibility).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is platform_ops", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));

    const res = await GET(makeGetRequest() as never);
    expect(res.status).toBe(403);
  });

  it("scopes the eligibility query to the session user — never accepts userId from elsewhere", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    getStudentEligibilityProfile.mockResolvedValue(profileShell);
    checkStudentEligibility.mockResolvedValue(eligibilityResult);

    await GET(makeGetRequest() as never);

    expect(checkStudentEligibility).toHaveBeenCalledTimes(1);
    expect(checkStudentEligibility.mock.calls[0]?.[0]).toBe("stud_1");
  });
});

describe("PATCH /api/v1/students/me/eligibility", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 with the updated profile and fresh eligibility on success", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    updateStudentEligibilityProfile.mockResolvedValue({
      profile: profileShell,
      eligibility: eligibilityResult,
    });

    const res = await PATCH(
      makePatchRequest({
        dateOfBirth: "2002-03-21",
        enrollmentStatus: "enrolled",
        educationLevel: "S1",
        universityName: "Universitas Indonesia",
        studentIdNumber: "1906345678",
      }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.eligibility.status).toBe("eligible");
    expect(updateStudentEligibilityProfile).toHaveBeenCalledWith("stud_1", expect.any(Object));
  });

  it("returns 400 when payload includes the protected status field", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);
    updateStudentEligibilityProfile.mockRejectedValue(
      new EligibilityInputError(
        "eligibility_protected_fields",
        "Eligibility status and reasons are server-computed and cannot be set by the client",
        { fields: ["status"] },
      ),
    );

    const res = await PATCH(makePatchRequest({ status: "eligible" }) as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("eligibility_protected_fields");
  });

  it("returns 400 on invalid JSON body", async () => {
    requireSessionRole.mockResolvedValue(candidateSession);

    const res = await PATCH(makePatchRequest("{not json") as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("eligibility_invalid_payload");
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await PATCH(makePatchRequest({ universityName: "X" }) as never);
    expect(res.status).toBe(401);
    expect(updateStudentEligibilityProfile).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is institution_staff", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));

    const res = await PATCH(makePatchRequest({ universityName: "X" }) as never);
    expect(res.status).toBe(403);
  });
});
