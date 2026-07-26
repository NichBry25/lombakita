// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockRequireSessionRole, mockGetCandidateProfile, mockUpdateCandidateProfile } = vi.hoisted(
  () => ({
    mockRequireSessionRole: vi.fn(),
    mockGetCandidateProfile: vi.fn(),
    mockUpdateCandidateProfile: vi.fn(),
  }),
);

vi.mock("@/server/auth/session", () => ({
  requireSessionRole: mockRequireSessionRole,
  requireAuthenticatedSession: vi.fn(),
}));
vi.mock("@/server/candidate/candidate-profile-service", () => ({
  getCandidateProfile: mockGetCandidateProfile,
  updateCandidateProfile: mockUpdateCandidateProfile,
}));

import { GET } from "@/app/api/v1/candidate/me/profile/route";

const candidateSession = {
  user: {
    id: "u_candidate",
    role: "candidate" as const,
    email: "c@example.com",
    verifiedRoles: ["candidate" as const],
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeGet = () => new Request("http://localhost/api/v1/candidate/me/profile");

describe("GET /api/v1/candidate/me/profile — absent-profile read path (OOB-CANDIDACY-T2)", () => {
  afterEach(() => vi.clearAllMocks());

  // A candidate-verified account with no candidate_profiles row (the permanent
  // migration-0015 operational-account carve-out) must read cleanly: HTTP 200 with an
  // explicit `profile: null`, never a 404 or 500. Downstream UI branches on this null.
  it("returns 200 with profile: null when the candidate has no profile row", async () => {
    mockRequireSessionRole.mockResolvedValue(candidateSession);
    mockGetCandidateProfile.mockResolvedValue(null);

    const res = await GET(makeGet() as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ profile: null });
    expect(mockGetCandidateProfile).toHaveBeenCalledWith("u_candidate");
  });

  it("returns 200 with the profile when a row exists", async () => {
    const profile = {
      userId: "u_candidate",
      fullName: "Budi",
      phoneNumber: "+628123456789",
      occupation: "professional",
      dateOfBirth: "1985-01-01",
    };
    mockRequireSessionRole.mockResolvedValue(candidateSession);
    mockGetCandidateProfile.mockResolvedValue(profile);

    const res = await GET(makeGet() as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ profile });
  });
});
