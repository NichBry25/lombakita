// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRedirect, mockLoadVerificationSummary, mockReadTickPageState } = vi.hoisted(() => ({
  mockRedirect: vi.fn((): never => {
    throw new Error("NEXT_REDIRECT");
  }),
  mockLoadVerificationSummary: vi.fn(),
  mockReadTickPageState: vi.fn(),
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
vi.mock("@/server/institution-verification/tick-service", () => ({
  readTickPageState: mockReadTickPageState,
}));
vi.mock("@/components/institution/institution-verification-shell", () => ({
  InstitutionVerificationShell: () => null,
}));

import InstitutionVerificationPage from "@/app/institution/[institutionSlug]/verification/page";
import { absoluteSiteUrl } from "@/config/site-url";

const PERSONAL_SUMMARY = {
  institutionId: "inst_1",
  slug: "ruang-uji",
  institutionType: "personal",
  verificationStatus: "pending_verification",
  verifiedAt: null,
  rejectionReason: null,
  tickPath: null,
  nameCheckedAt: null,
  nameProofDueAt: null,
  displayName: "Ruang Uji",
};

const MATCHING_TICK_STATE = {
  workspaceClosure: null,
  otherWorkspaceClosure: null,
  hasPublishedPaidCompetition: false,
  organizationEmailDomain: "students.acme.example",
  websiteHost: "acme.example",
  domainsMatch: true,
};

const callPage = () =>
  InstitutionVerificationPage({ params: Promise.resolve({ institutionSlug: "ruang-uji" }) });

describe("the workspace verification page", () => {
  beforeEach(() => mockReadTickPageState.mockResolvedValue(MATCHING_TICK_STATE));
  afterEach(() => vi.clearAllMocks());

  it("renders the tick page for a personal workspace", async () => {
    mockLoadVerificationSummary.mockResolvedValue(PERSONAL_SUMMARY);

    const element = (await callPage()) as { props: { institutionType: string } };

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(element.props.institutionType).toBe("personal");
    expect(mockReadTickPageState).toHaveBeenCalledWith("user_owner", "inst_1");
  });

  it("passes the tick state of a company workspace", async () => {
    mockLoadVerificationSummary.mockResolvedValue({
      ...PERSONAL_SUMMARY,
      institutionType: "company",
      verificationStatus: "verified",
      tickPath: "domain",
      nameCheckedAt: null,
      nameProofDueAt: new Date("2026-12-31T00:00:00.000Z"),
    });

    const element = (await callPage()) as { props: unknown };

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(element.props).toEqual({
      institutionSlug: "ruang-uji",
      expectedUserId: "user_owner",
      institutionId: "inst_1",
      institutionType: "company",
      displayName: "Ruang Uji",
      pageUrl: absoluteSiteUrl("/institution/ruang-uji"),
      isVerified: true,
      rejectionReason: null,
      tickPath: "domain",
      nameChecked: false,
      nameProofDueAt: "2026-12-31T00:00:00.000Z",
      tickState: MATCHING_TICK_STATE,
    });
  });

  it("builds the Instagram page link from the stored slug, not the address typed", async () => {
    mockLoadVerificationSummary.mockResolvedValue(PERSONAL_SUMMARY);

    const element = (await InstitutionVerificationPage({
      params: Promise.resolve({ institutionSlug: "Ruang-Uji" }),
    })) as { props: { pageUrl: string } };

    expect(element.props.pageUrl).toBe(absoluteSiteUrl("/institution/ruang-uji"));
  });

  it("sends a slug with no summary to the host dashboard", async () => {
    mockLoadVerificationSummary.mockResolvedValue(null);

    await expect(callPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(mockRedirect).toHaveBeenCalledWith("/recruiter-dashboard");
  });
});
