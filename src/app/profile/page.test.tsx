// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOwnerProfileResponse } from "@/server/user-profile/profile-core";
import { emptyProfileCollections } from "@/server/user-profile/profile-collections-core";

const { mockGetCurrentSession, mockGetOwnerProfile, mockRedirect } = vi.hoisted(() => ({
  mockGetCurrentSession: vi.fn(),
  mockGetOwnerProfile: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: mockGetCurrentSession }));
vi.mock("@/server/user-profile/profile-service", () => ({
  getOwnerProfile: mockGetOwnerProfile,
}));

import OwnerProfilePage from "@/app/profile/page";

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

const recruiterSession = {
  user: {
    id: "u1",
    email: "john@example.com",
    role: "recruiter",
    verifiedRoles: ["recruiter"],
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const dualRoleCandidateSession = {
  user: {
    id: "u1",
    email: "john@example.com",
    role: "candidate",
    verifiedRoles: ["candidate", "recruiter"],
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

describe("the owner profile badges", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows the owner no recruiter badge before platform ops approve", async () => {
    mockGetCurrentSession.mockResolvedValue(recruiterSession);
    mockGetOwnerProfile.mockResolvedValue(
      buildOwnerProfileResponse(
        {
          ...baseRow,
          role: "recruiter",
          candidateVerifiedAt: null,
          recruiterVerifiedAt: new Date(),
          recruiterVerificationTier: "minimal",
        },
        emptyProfileCollections(),
      ),
    );

    const html = renderToStaticMarkup(await OwnerProfilePage());

    expect(html).not.toContain("Rekruter Terverifikasi");
  });

  it("shows no badge row and keeps the second-role button for a recruiter awaiting approval", async () => {
    mockGetCurrentSession.mockResolvedValue(recruiterSession);
    mockGetOwnerProfile.mockResolvedValue(
      buildOwnerProfileResponse(
        {
          ...baseRow,
          role: "recruiter",
          candidateVerifiedAt: null,
          recruiterVerifiedAt: new Date(),
          recruiterVerificationTier: "minimal",
        },
        emptyProfileCollections(),
      ),
    );

    const html = renderToStaticMarkup(await OwnerProfilePage());

    expect(html).not.toContain("pf-badges");
    expect(html).toContain("Verifikasi sebagai Kandidat");
  });

  it("shows the owner only the candidate badge while the recruiter role awaits approval", async () => {
    mockGetCurrentSession.mockResolvedValue(dualRoleCandidateSession);
    mockGetOwnerProfile.mockResolvedValue(
      buildOwnerProfileResponse(
        {
          ...baseRow,
          candidateVerifiedAt: new Date(),
          recruiterVerifiedAt: new Date(),
          recruiterVerificationTier: "minimal",
        },
        emptyProfileCollections(),
      ),
    );

    const html = renderToStaticMarkup(await OwnerProfilePage());

    expect(html).toContain("Kandidat Terverifikasi");
    expect(html).toContain('data-status="verified"');
    expect(html).not.toContain('data-status="open"');
    expect(html).not.toContain("Rekruter Terverifikasi");
    expect(html).not.toContain("Penyelenggara terverifikasi");
  });

  it("offers a participant the host step as Mulai menyelenggarakan", async () => {
    mockGetCurrentSession.mockResolvedValue({
      user: {
        id: "u1",
        email: "john@example.com",
        role: "candidate",
        verifiedRoles: ["candidate"],
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    });
    mockGetOwnerProfile.mockResolvedValue(
      buildOwnerProfileResponse(
        {
          ...baseRow,
          candidateVerifiedAt: new Date(),
          recruiterVerifiedAt: null,
          recruiterVerificationTier: "unverified",
        },
        emptyProfileCollections(),
      ),
    );

    const html = renderToStaticMarkup(await OwnerProfilePage());

    expect(html).toContain("Mulai menyelenggarakan");
    expect(html).not.toContain("Verifikasi sebagai Penyelenggara");
  });
});
