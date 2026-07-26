// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { getPublicProfile } = vi.hoisted(() => ({
  getPublicProfile: vi.fn(),
}));

vi.mock("@/server/user-profile/profile-service", () => ({
  getPublicProfile,
}));

import { GET } from "@/app/api/v1/users/[username]/profile/route";

const makeRequest = (username: string) =>
  new Request(`http://localhost/api/v1/users/${username}/profile`);

const makeParams = (username: string): { params: Promise<{ username: string }> } => ({
  params: Promise.resolve({ username }),
});

describe("GET /api/v1/users/[username]/profile", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 404 for an unknown username", async () => {
    getPublicProfile.mockResolvedValue(null);

    const res = await GET(makeRequest("nonexistent") as never, makeParams("nonexistent"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("profile_not_found");
    expect(getPublicProfile).toHaveBeenCalledWith("nonexistent");
  });

  it("returns public profile for a known username", async () => {
    getPublicProfile.mockResolvedValue({
      username: "john_abc1",
      displayName: "John Doe",
      bio: "A developer",
      location: "Jakarta",
      avatarUrl: null,
      candidateVerified: true,
      recruiterVerified: false,
      collections: {
        experiences: [],
        educations: [
          {
            id: "e1",
            school: "UI",
            degree: null,
            fieldOfStudy: "CS",
            startYear: null,
            endYear: 2024,
            description: null,
          },
        ],
        skills: [],
        certifications: [],
        socialLinks: [],
      },
    });

    const res = await GET(makeRequest("john_abc1") as never, makeParams("john_abc1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.profile.username).toBe("john_abc1");
    expect(body.profile.displayName).toBe("John Doe");
    expect(body.profile.collections.educations).toHaveLength(1);
    expect(getPublicProfile).toHaveBeenCalledWith("john_abc1");
  });

  it("does not include status wrappers in public response shape", async () => {
    getPublicProfile.mockResolvedValue({
      username: "john_abc1",
      displayName: "John",
      bio: null,
      location: null,
      avatarUrl: null,
      candidateVerified: false,
      recruiterVerified: false,
      collections: {
        experiences: [],
        educations: [],
        skills: [],
        certifications: [],
        socialLinks: [],
      },
    });

    const res = await GET(makeRequest("john_abc1") as never, makeParams("john_abc1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    // Public response values must NOT be wrapped in { status, value } objects.
    expect(typeof body.profile.displayName).toBe("string");
    expect(body.profile.bio).toBeNull();
  });
});
