// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";

vi.mock("@/server/institution-workspace/institution-service", () => ({
  findOwnedPersonalInstitution: vi.fn(),
  usernameCollidesWithInstitutionSlug: vi.fn(),
  rewritePersonalInstitutionSlugForUsername: vi.fn(),
}));

vi.mock("@/server/async/enqueue", () => ({ enqueueCompetitionSearchSync: vi.fn() }));

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => true,
  generatePresignedGetUrl: vi.fn(async (key: string) => `https://r2.example/get/${key}`),
}));

import { getOwnerProfile, getPublicProfile } from "@/server/user-profile/profile-service";

const profileRow = (overrides: Record<string, unknown> = {}) => ({
  id: "user_1",
  username: "alice",
  email: "alice@example.com",
  role: "candidate",
  candidateVerifiedAt: new Date("2026-06-01T00:00:00.000Z"),
  recruiterVerifiedAt: null,
  recruiterVerificationTier: "unverified",
  displayName: "Alice",
  summary: null,
  location: null,
  avatarUrl: null,
  avatarR2Key: null,
  bannerR2Key: null,
  resumeR2Key: null,
  resumeFileName: null,
  resumeSizeBytes: null,
  resumeMimeType: null,
  resumePublic: false,
  ...overrides,
});

const makeProfileDb = (row: unknown) => {
  const selectNode = (): Record<string, unknown> => {
    const n: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "where"]) {
      n[m] = () => n;
    }
    n.limit = async () => [row];
    n.orderBy = async () => [];
    return n;
  };
  return { select: () => selectNode() } as unknown as Database;
};

describe("profile banner read path", () => {
  it("presigns the stored banner key for the owner view", async () => {
    const db = makeProfileDb(profileRow({ bannerR2Key: "banners/user_1/cover.jpg" }));

    const profile = await getOwnerProfile("user_1", db);

    expect(profile.bannerUrl).toEqual({
      status: "populated",
      value: "https://r2.example/get/banners/user_1/cover.jpg",
    });
  });

  it("reports an absent banner as empty rather than omitting the field", async () => {
    const db = makeProfileDb(profileRow());

    expect((await getOwnerProfile("user_1", db)).bannerUrl).toEqual({
      status: "empty",
      value: null,
    });
  });

  // The banner is public: unlike the resume it has no visibility flag, so it is shown to anyone
  // viewing the profile.
  it("exposes the banner on the public profile", async () => {
    const db = makeProfileDb(profileRow({ bannerR2Key: "banners/user_1/cover.jpg" }));

    expect((await getPublicProfile("alice", db))?.bannerUrl).toBe(
      "https://r2.example/get/banners/user_1/cover.jpg",
    );
  });

  it("returns a null public banner when none is stored", async () => {
    const db = makeProfileDb(profileRow());

    expect((await getPublicProfile("alice", db))?.bannerUrl).toBeNull();
  });
});
