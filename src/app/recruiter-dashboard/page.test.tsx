// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { mockReadHostStatusForAccount, mockHostStatusCard } = vi.hoisted(() => ({
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
vi.mock("@/server/host-trust/host-check-service", () => ({
  readHostStatusForAccount: mockReadHostStatusForAccount,
}));
vi.mock("@/server/institution-workspace/institution-service", () => ({
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

const renderDashboard = async (hostStatus: unknown = NOT_TRUSTED_STATUS) => {
  mockReadHostStatusForAccount.mockResolvedValue(hostStatus);
  return renderToStaticMarkup(await RecruiterDashboardPage());
};

const linkHolding = (html: string, text: string) => {
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
  return anchors.find((anchor) => anchor.includes(text));
};

describe("the host dashboard cards", () => {
  afterEach(() => vi.clearAllMocks());

  it("offers every host one Buat institusi card", async () => {
    const html = await renderDashboard();

    expect(html.match(/<h2>Buat institusi<\/h2>/g)?.length).toBe(1);
    const card = linkHolding(html, "Buat institusi");
    expect(card).toContain('href="/institution/create"');
    expect(card).toContain("hub-card hub-card--action");
    expect(html).toContain(
      "Buat ruang penyelenggara baru, pribadi atau organisasi. Satu akun dapat memiliki hingga 3 institusi.",
    );
    expect(html).not.toContain('href="/institution/personal"');
    expect(html).not.toContain("Mulai menyelenggarakan");
  });

  it("passes the account's host status to the status card", async () => {
    const waitingStatus = { state: "pending", competitionTitle: "Lomba Esai Nasional" };

    await renderDashboard(waitingStatus);

    expect(mockReadHostStatusForAccount).toHaveBeenCalledWith("user_host");
    expect(mockHostStatusCard.mock.calls[0]?.[0]).toEqual({
      expectedUserId: "user_host",
      status: waitingStatus,
    });
  });
});
