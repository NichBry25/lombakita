// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockRedirect, mockLoadVerificationSummary } = vi.hoisted(() => ({
  mockRedirect: vi.fn((): never => {
    throw new Error("NEXT_REDIRECT");
  }),
  mockLoadVerificationSummary: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/server/auth/page-guard", () => ({
  requireRolePage: vi.fn().mockResolvedValue({ user: { id: "user_owner" } }),
}));
vi.mock("@/server/institution-members/member-service", () => ({
  isInstitutionAdminBySlug: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  loadInstitutionVerificationSummaryBySlug: mockLoadVerificationSummary,
}));
vi.mock("@/components/institution/institution-verification-shell", () => ({
  InstitutionVerificationShell: () => null,
}));

import InstitutionVerificationPage from "@/app/institution/[institutionSlug]/verification/page";

const PERSONAL_SUMMARY = {
  institutionId: "inst_1",
  institutionType: "personal",
  verificationStatus: "pending_verification",
  verifiedAt: null,
  rejectionReason: null,
  displayName: "Ruang Uji",
};

const callPage = () =>
  InstitutionVerificationPage({ params: Promise.resolve({ institutionSlug: "ruang-uji" }) });

describe("the workspace verification page", () => {
  afterEach(() => vi.clearAllMocks());

  it("sends the owner of a personal workspace to the workspace hub", async () => {
    mockLoadVerificationSummary.mockResolvedValue(PERSONAL_SUMMARY);

    await expect(callPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith("/institution/ruang-uji");
  });

  it("renders document verification for a company workspace", async () => {
    mockLoadVerificationSummary.mockResolvedValue({
      ...PERSONAL_SUMMARY,
      institutionType: "company",
      verificationStatus: "verified",
      verifiedAt: new Date("2026-11-01T00:00:00.000Z"),
    });

    const element = (await callPage()) as { props: unknown };

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(element.props).toEqual({
      institutionSlug: "ruang-uji",
      expectedUserId: "user_owner",
      institutionType: "company",
      isVerified: true,
      verifiedAt: "2026-11-01T00:00:00.000Z",
      rejectionReason: null,
    });
  });

  it("sends a slug with no summary to the host dashboard", async () => {
    mockLoadVerificationSummary.mockResolvedValue(null);

    await expect(callPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(mockRedirect).toHaveBeenCalledWith("/recruiter-dashboard");
  });
});
