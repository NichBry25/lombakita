// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  mockGetRecruiterTierForAccount,
  mockFindOwnedPersonalInstitution,
  mockReadHostStatusForAccount,
  mockHostStatusCard,
} = vi.hoisted(() => ({
  mockGetRecruiterTierForAccount: vi.fn(),
  mockFindOwnedPersonalInstitution: vi.fn(),
  mockReadHostStatusForAccount: vi.fn(),
  mockHostStatusCard: vi.fn<(props: unknown) => null>(() => null),
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
vi.mock("@/server/host-trust/host-check-service", () => ({
  readHostStatusForAccount: mockReadHostStatusForAccount,
}));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  findOwnedPersonalInstitution: mockFindOwnedPersonalInstitution,
  listUserInstitutionMemberships: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/components/host/host-status-card", () => ({
  HostStatusCard: mockHostStatusCard,
}));
vi.mock("@/components/auth/second-role-banner", () => ({
  SecondRoleBanner: () => null,
}));

import RecruiterDashboardPage from "@/app/recruiter-dashboard/page";

const NOT_TRUSTED_STATUS = { state: "not_trusted" };

const renderDashboard = async (
  tier: string,
  personalInstitution: unknown,
  hostStatus: unknown = NOT_TRUSTED_STATUS,
) => {
  mockGetRecruiterTierForAccount.mockResolvedValue({ recruiterVerificationTier: tier });
  mockFindOwnedPersonalInstitution.mockResolvedValue(personalInstitution);
  mockReadHostStatusForAccount.mockResolvedValue(hostStatus);
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

  it("passes the account's host status to the status card", async () => {
    const waitingStatus = { state: "pending", competitionTitle: "Lomba Esai Nasional" };

    await renderDashboard("minimal", null, waitingStatus);

    expect(mockReadHostStatusForAccount).toHaveBeenCalledWith("user_host");
    expect(mockHostStatusCard.mock.calls[0]?.[0]).toEqual({
      expectedUserId: "user_host",
      status: waitingStatus,
    });
  });
});
