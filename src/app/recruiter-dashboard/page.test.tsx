// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { mockGetRecruiterTierForAccount, mockFindOwnedPersonalInstitution } = vi.hoisted(() => ({
  mockGetRecruiterTierForAccount: vi.fn(),
  mockFindOwnedPersonalInstitution: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/page-guard", () => ({
  requireRolePage: vi.fn().mockResolvedValue({ user: { id: "user_host" } }),
}));
vi.mock("@/server/auth/role-verification", () => ({
  getUnverifiedRoles: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/server/auth/recruiter-tier", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/recruiter-tier")>(
    "@/server/auth/recruiter-tier",
  );
  return { ...actual, getRecruiterTierForAccount: mockGetRecruiterTierForAccount };
});
vi.mock("@/server/recruiter-verification/recruiter-verification-service", () => ({
  getLatestRecruiterVerificationForUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  findOwnedPersonalInstitution: mockFindOwnedPersonalInstitution,
  listUserInstitutionMemberships: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/app/recruiter-dashboard/recruiter-verification-panel", () => ({
  RecruiterVerificationPanel: () => null,
}));
vi.mock("@/components/auth/second-role-banner", () => ({
  SecondRoleBanner: () => null,
}));

import RecruiterDashboardPage from "@/app/recruiter-dashboard/page";

const renderDashboard = async (tier: string, personalInstitution: unknown) => {
  mockGetRecruiterTierForAccount.mockResolvedValue({ recruiterVerificationTier: tier });
  mockFindOwnedPersonalInstitution.mockResolvedValue(personalInstitution);
  return renderToStaticMarkup(await RecruiterDashboardPage());
};

const linkHolding = (html: string, text: string) => {
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
  return anchors.find((anchor) => anchor.includes(text));
};

describe("the host dashboard cards", () => {
  afterEach(() => vi.clearAllMocks());

  it("offers Buat institusi only to an approved host", async () => {
    const approvedHtml = await renderDashboard("elevated", null);
    expect(approvedHtml).toContain("<h2>Buat institusi</h2>");
    expect(approvedHtml).toContain('href="/institution/create"');

    const waitingHtml = await renderDashboard("minimal", null);
    expect(waitingHtml).not.toContain("<h2>Buat institusi</h2>");
    expect(waitingHtml).not.toContain('href="/institution/create"');
  });

  it("starts hosting at the start page when there is no personal workspace", async () => {
    const html = await renderDashboard("minimal", null);

    expect(linkHolding(html, "Mulai menyelenggarakan")).toContain('href="/institution/personal"');
  });

  it("starts hosting at a new draft of the existing personal workspace", async () => {
    const html = await renderDashboard("minimal", { institutionId: "inst_budi", slug: "budi" });

    expect(linkHolding(html, "Mulai menyelenggarakan")).toContain(
      'href="/institution/budi/competitions/new"',
    );
  });
});
