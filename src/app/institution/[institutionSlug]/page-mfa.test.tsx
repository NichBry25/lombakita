// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicInstitution } from "@/server/institution-workspace/institution-public-service";

const state = vi.hoisted(() => ({
  session: vi.fn(),
  select: vi.fn(),
  contacts: vi.fn(),
  member: vi.fn(),
}));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: state.session }));
vi.mock("@/server/auth/page-guard", () => ({ requireRolePage: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: () => ({ select: state.select }) }));
vi.mock("@/server/institution-members/member-service", () => ({
  isInstitutionAdminBySlug: async () => false,
  isInstitutionMemberBySlug: state.member,
}));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  loadInstitutionVerificationSummaryBySlug: vi.fn(),
}));
vi.mock("@/server/finance/charging-readiness", () => ({ resolveChargingReadiness: vi.fn() }));
vi.mock("@/server/competitions/competition-public-service", () => ({
  listPublicCompetitions: async () => ({ data: [] }),
}));
vi.mock("@/server/storage/r2.client", () => ({ isR2Available: () => false }));
vi.mock("@/components/ui", () => ({
  ButtonLink: () => null,
  Icon: () => null,
  PageHeader: () => null,
}));
vi.mock("@/components/institution/charging-readiness-panel", () => ({
  ChargingReadinessPanel: () => null,
}));
vi.mock("@/components/institution/institution-public-view", () => ({
  InstitutionPublicView: ({ institution }: { institution: PublicInstitution }) => {
    state.contacts(institution);
    return (
      <div>
        {institution.contactName}
        {institution.contactEmail}
        {institution.contactPhone}
      </div>
    );
  },
}));

// The page and contact-disclosure service are real; the database transport supplies an
// unverified institution with contacts and the membership boundary answers non-member.
import Page from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  state.member.mockResolvedValue(false);
  const rows = [
    [
      {
        id: "institution",
        slug: "test-institution",
        displayName: "Test Institution",
        institutionType: "company",
        verificationStatus: "pending_verification",
        contactName: "Private Contact",
        contactEmail: "private@example.test",
        contactPhone: "0800",
        logoR2Key: null,
        bannerR2Key: null,
      },
    ],
    [],
  ];
  state.select.mockImplementation(() => {
    const node: Record<string, unknown> = {};
    for (const method of ["from", "where", "limit"]) node[method] = () => node;
    node.then = (resolve: (value: unknown) => void) => resolve(rows.shift() ?? []);
    return node;
  });
});

describe("institution page operational contact disclosure", () => {
  it.each(["enrolment_required", "challenge_required", undefined])(
    "withholds unverified contacts from a non-member platform operator with %s MFA",
    async (mfaStatus) => {
      state.session.mockResolvedValue({
        user: { id: "operator", role: "platform_ops", mfaStatus },
      });
      const html = renderToStaticMarkup(
        await Page({
          params: Promise.resolve({ institutionSlug: "test-institution" }),
          searchParams: Promise.resolve({}),
        }),
      );
      expect(state.contacts).toHaveBeenCalledWith(
        expect.objectContaining({
          contactName: null,
          contactEmail: null,
          contactPhone: null,
          contactDisclosure: { kind: "hidden" },
        }),
      );
      expect(html).not.toContain("Private Contact");
      expect(html).not.toContain("private@example.test");
      expect(html).not.toContain("0800");
    },
  );
  it("discloses unverified contacts to a satisfied non-member platform operator", async () => {
    state.session.mockResolvedValue({
      user: { id: "operator", role: "platform_ops", mfaStatus: "satisfied" },
    });
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ institutionSlug: "test-institution" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(state.contacts).toHaveBeenCalledWith(
      expect.objectContaining({
        contactEmail: "private@example.test",
        contactDisclosure: { kind: "members_only", viewerIsPlatformOps: true },
      }),
    );
    expect(html).toContain("private@example.test");
  });
  it("withholds unverified contacts from a satisfied non-member finance operator", async () => {
    state.session.mockResolvedValue({
      user: { id: "finance-operator", role: "finance_ops", mfaStatus: "satisfied" },
    });
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ institutionSlug: "test-institution" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(state.contacts).toHaveBeenCalledWith(
      expect.objectContaining({
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        contactDisclosure: { kind: "hidden" },
      }),
    );
    expect(html).not.toContain("Private Contact");
    expect(html).not.toContain("private@example.test");
    expect(html).not.toContain("0800");
  });
});

describe("institution page suspended member contact disclosure", () => {
  it("withholds unverified contacts from a suspended member as an anonymous viewer", async () => {
    state.member.mockResolvedValue(true);
    state.session.mockResolvedValue({
      user: { id: "member", role: "candidate", suspendedAt: "2026-10-14T00:00:00.000Z" },
    });
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ institutionSlug: "test-institution" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(state.contacts).toHaveBeenCalledWith(
      expect.objectContaining({
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        contactDisclosure: { kind: "hidden" },
      }),
    );
    expect(state.member).not.toHaveBeenCalled();
    expect(html).not.toContain("Private Contact");
    expect(html).not.toContain("private@example.test");
    expect(html).not.toContain("0800");
  });
  it("still discloses unverified contacts to an active member", async () => {
    state.member.mockResolvedValue(true);
    state.session.mockResolvedValue({ user: { id: "member", role: "candidate" } });
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ institutionSlug: "test-institution" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(state.contacts).toHaveBeenCalledWith(
      expect.objectContaining({
        contactDisclosure: { kind: "members_only", viewerIsPlatformOps: false },
      }),
    );
    expect(html).toContain("Private Contact");
    expect(html).toContain("private@example.test");
    expect(html).toContain("0800");
  });
});
