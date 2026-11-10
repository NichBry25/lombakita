// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPublicProfileResponse } from "@/server/user-profile/profile-core";
import { emptyProfileCollections } from "@/server/user-profile/profile-collections-core";

const {
  mockGetCurrentSession,
  mockGetPublicProfile,
  mockIsUsernameOwnedBy,
  mockNotFound,
  mockRedirect,
} = vi.hoisted(() => ({
  mockGetCurrentSession: vi.fn(),
  mockGetPublicProfile: vi.fn(),
  mockIsUsernameOwnedBy: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  mockRedirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mockNotFound, redirect: mockRedirect }));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: mockGetCurrentSession }));
vi.mock("@/server/user-profile/profile-service", () => ({
  getPublicProfile: mockGetPublicProfile,
  isUsernameOwnedBy: mockIsUsernameOwnedBy,
}));

import PublicProfilePage, { generateMetadata } from "@/app/[username]/page";

const baseRow = {
  id: "u1",
  username: "john_abc1",
  email: "john@example.com",
  role: "candidate",
  recruiterVerificationTier: "unverified" as const,
  displayName: "John Doe",
  summary: "A developer",
  location: "Jakarta",
  avatarUrl: null,
};

const renderPublicProfile = async () => {
  const page = await PublicProfilePage({ params: Promise.resolve({ username: "john_abc1" }) });
  return renderToStaticMarkup(page);
};

describe("the public profile badges", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows no recruiter badge for a recruiter platform ops have not approved", async () => {
    mockGetCurrentSession.mockResolvedValue(null);
    mockIsUsernameOwnedBy.mockResolvedValue(false);
    mockGetPublicProfile.mockResolvedValue(
      buildPublicProfileResponse(
        {
          ...baseRow,
          candidateVerifiedAt: null,
          recruiterVerifiedAt: new Date(),
          recruiterVerificationTier: "minimal",
        },
        emptyProfileCollections(),
      ),
    );

    const html = await renderPublicProfile();

    expect(html).not.toContain("Rekruter Terverifikasi");
    expect(html).not.toContain("Rekruter Terpercaya");
    expect(html).not.toContain("pf-badges");
  });

  it("shows the trusted badge for a recruiter platform ops approved", async () => {
    mockGetCurrentSession.mockResolvedValue(null);
    mockIsUsernameOwnedBy.mockResolvedValue(false);
    mockGetPublicProfile.mockResolvedValue(
      buildPublicProfileResponse(
        {
          ...baseRow,
          candidateVerifiedAt: null,
          recruiterVerifiedAt: new Date(),
          recruiterVerificationTier: "elevated",
        },
        emptyProfileCollections(),
      ),
    );

    const html = await renderPublicProfile();

    expect(html).toContain("Rekruter Terpercaya");
    expect(html).not.toContain("Rekruter Terverifikasi");
  });

  it("shows only the candidate badge for a candidate whose recruiter role awaits approval", async () => {
    mockGetCurrentSession.mockResolvedValue(null);
    mockIsUsernameOwnedBy.mockResolvedValue(false);
    mockGetPublicProfile.mockResolvedValue(
      buildPublicProfileResponse(
        {
          ...baseRow,
          candidateVerifiedAt: new Date(),
          recruiterVerifiedAt: new Date(),
          recruiterVerificationTier: "minimal",
        },
        emptyProfileCollections(),
      ),
    );

    const html = await renderPublicProfile();

    expect(html).toContain("Kandidat Terverifikasi");
    expect(html).not.toContain("Rekruter Terverifikasi");
    expect(html).not.toContain("Rekruter Terpercaya");
  });
});

describe("the public profile page without a profile", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows the not-found page for an account with no public profile", async () => {
    const notFoundError = new Error("NEXT_NOT_FOUND");
    mockGetCurrentSession.mockResolvedValue(null);
    mockIsUsernameOwnedBy.mockResolvedValue(false);
    mockGetPublicProfile.mockResolvedValue(null);
    const params = Promise.resolve({ username: "john_abc1" });

    await expect(PublicProfilePage({ params })).rejects.toThrow(notFoundError);
    await expect(generateMetadata({ params })).resolves.toMatchObject({
      title: "Profil tidak ditemukan · Lombakita",
    });
  });
});
