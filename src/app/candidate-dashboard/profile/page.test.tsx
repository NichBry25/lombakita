// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { mockGetCurrentSession, mockGetUnverifiedRoles, mockGetCandidateProfile, mockRedirect } =
  vi.hoisted(() => ({
    mockGetCurrentSession: vi.fn(),
    mockGetUnverifiedRoles: vi.fn(),
    mockGetCandidateProfile: vi.fn(),
    mockRedirect: vi.fn(),
  }));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: mockGetCurrentSession }));
vi.mock("@/server/auth/role-verification", () => ({ getUnverifiedRoles: mockGetUnverifiedRoles }));
vi.mock("@/server/candidate/candidate-profile-service", () => ({
  getCandidateProfile: mockGetCandidateProfile,
}));
// The editor is a client component with its own provider dependencies — stub it so the page
// renders under renderToStaticMarkup without wiring the primitives context.
vi.mock("./candidate-profile-editor", () => ({
  CandidateProfileEditor: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", null, "CANDIDATE_EDITOR_STUB");
  },
}));

import CandidateProfilePage from "@/app/candidate-dashboard/profile/page";

const validSession = {
  user: {
    id: "u_candidate",
    email: "c@example.com",
    role: "candidate",
    verifiedRoles: ["candidate"],
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const setupVerifiedCandidate = () => {
  mockGetCurrentSession.mockResolvedValue(validSession);
  mockGetUnverifiedRoles.mockResolvedValue([]);
};

describe("CandidateProfilePage — absent-profile read path (OOB-CANDIDACY-T2)", () => {
  afterEach(() => vi.clearAllMocks());

  // A candidate-verified account with no candidate_profiles row (permanent migration-0015
  // carve-out) reaches the dashboard profile page. It must render the explanatory fallback,
  // not the editor and not an error.
  it("renders the 'belum tersedia' fallback and no editor when the profile row is absent", async () => {
    setupVerifiedCandidate();
    mockGetCandidateProfile.mockResolvedValue(null);

    const html = renderToStaticMarkup(await CandidateProfilePage());

    expect(html).toContain("Data kandidat Anda belum tersedia");
    expect(html).not.toContain("CANDIDATE_EDITOR_STUB");
  });

  it("renders the editor when the profile row exists", async () => {
    setupVerifiedCandidate();
    mockGetCandidateProfile.mockResolvedValue({
      userId: "u_candidate",
      fullName: "Budi",
      phoneNumber: "+628123456789",
      occupation: "professional",
      dateOfBirth: "1985-01-01",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const html = renderToStaticMarkup(await CandidateProfilePage());

    expect(html).toContain("CANDIDATE_EDITOR_STUB");
    expect(html).not.toContain("Data kandidat Anda belum tersedia");
  });
});
