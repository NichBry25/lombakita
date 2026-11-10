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
});
