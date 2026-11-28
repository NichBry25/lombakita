// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockRedirect, mockIsInstitutionOwnerBySlug, mockLoadVerificationSummary } = vi.hoisted(
  () => ({
    mockRedirect: vi.fn((): never => {
      throw new Error("NEXT_REDIRECT");
    }),
    mockIsInstitutionOwnerBySlug: vi.fn(),
    mockLoadVerificationSummary: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/server/auth/page-guard", () => ({
  requireRolePage: vi.fn().mockResolvedValue({ user: { id: "user_owner" } }),
}));
vi.mock("@/server/institution-members/member-service", () => ({
  isInstitutionOwnerBySlug: mockIsInstitutionOwnerBySlug,
}));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  loadInstitutionVerificationSummaryBySlug: mockLoadVerificationSummary,
}));
vi.mock("@/components/institution/institution-settings-shell", () => ({
  InstitutionSettingsShell: () => null,
}));

import InstitutionSettingsPage from "@/app/institution/[institutionSlug]/settings/page";

const callPage = () =>
  InstitutionSettingsPage({ params: Promise.resolve({ institutionSlug: "academy" }) });

describe("the workspace settings page", () => {
  afterEach(() => vi.clearAllMocks());

  it("passes the tick path of the workspace to the settings shell", async () => {
    mockIsInstitutionOwnerBySlug.mockResolvedValue(true);
    mockLoadVerificationSummary.mockResolvedValue({ tickPath: "instagram" });

    const element = (await callPage()) as { props: unknown };

    expect(element.props).toEqual({
      institutionSlug: "academy",
      expectedUserId: "user_owner",
      tickPath: "instagram",
    });
  });

  it("passes no tick path when the slug has no summary", async () => {
    mockIsInstitutionOwnerBySlug.mockResolvedValue(true);
    mockLoadVerificationSummary.mockResolvedValue(null);

    const element = (await callPage()) as { props: unknown };

    expect(element.props).toEqual({
      institutionSlug: "academy",
      expectedUserId: "user_owner",
      tickPath: null,
    });
  });

  it("sends a member who is not an owner to the home page", async () => {
    mockIsInstitutionOwnerBySlug.mockResolvedValue(false);

    await expect(callPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(mockRedirect).toHaveBeenCalledWith("/");
    expect(mockLoadVerificationSummary).not.toHaveBeenCalled();
  });
});
