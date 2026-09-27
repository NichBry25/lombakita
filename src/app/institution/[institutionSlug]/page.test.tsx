// @vitest-environment node

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  mockGetCurrentSession,
  mockIsInstitutionAdminBySlug,
  mockGetPublicInstitution,
  mockIsIndexableInstitution,
  mockLoadVerificationSummary,
  mockResolveChargingReadiness,
  mockRequireRolePage,
  mockListPublicCompetitions,
  mockNotFound,
} = vi.hoisted(() => ({
  mockGetCurrentSession: vi.fn(),
  mockIsInstitutionAdminBySlug: vi.fn(),
  mockGetPublicInstitution: vi.fn(),
  mockIsIndexableInstitution: vi.fn(),
  mockLoadVerificationSummary: vi.fn(),
  mockResolveChargingReadiness: vi.fn(),
  mockRequireRolePage: vi.fn(),
  mockListPublicCompetitions: vi.fn(),
  mockNotFound: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mockNotFound, redirect: vi.fn() }));
vi.mock("@/components/ui", () => ({
  ButtonLink: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  Icon: () => null,
  PageHeader: ({ title }: { title?: ReactNode }) => <h1>{title}</h1>,
}));
vi.mock("@/components/institution/institution-public-view", () => ({
  InstitutionPublicView: ({ institution }: { institution: { slug: string } }) => (
    <div>PUBLIC_VIEW:{institution.slug}</div>
  ),
}));
vi.mock("@/components/institution/charging-readiness-panel", () => ({
  ChargingReadinessPanel: () => null,
}));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: mockGetCurrentSession }));
vi.mock("@/server/auth/page-guard", () => ({ requireRolePage: mockRequireRolePage }));
vi.mock("@/server/institution-members/member-service", () => ({
  isInstitutionAdminBySlug: mockIsInstitutionAdminBySlug,
}));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  loadInstitutionVerificationSummaryBySlug: mockLoadVerificationSummary,
}));
vi.mock("@/server/institution-workspace/institution-public-service", () => ({
  getPublicInstitution: mockGetPublicInstitution,
  isIndexableInstitution: mockIsIndexableInstitution,
}));
vi.mock("@/server/finance/charging-readiness", () => ({
  resolveChargingReadiness: mockResolveChargingReadiness,
}));
vi.mock("@/server/competitions/competition-public-service", () => ({
  listPublicCompetitions: mockListPublicCompetitions,
}));

import InstitutionHubPage, { generateMetadata } from "@/app/institution/[institutionSlug]/page";

// `@/server/institution-workspace/institution-core` is deliberately NOT mocked: `parseInstitutionSlugParam`
// is the production normaliser these tests exist to hold the page to. Nothing here restates what it
// does; the raw string goes in and the assertions read what came out the other side.

const TYPED_SLUG = "SEED-ACADEMY";
const NORMALISED_SLUG = "seed-academy";

// The membership lookup as the database answers it: the column stores slugs lowercase, so a request
// naming the slug in any other casing is a request about a different string and matches nothing. Both
// roles the hub is for are members here — `isInstitutionAdminBySlug` answers true for an owner and for
// staff alike, which is why one membership set stands in for both without the page seeing a difference.
const MEMBER_USER_IDS = new Set(["user_owner", "user_staff"]);
const NON_MEMBER_USER_ID = "user_outsider";

const INSTITUTION = {
  slug: NORMALISED_SLUG,
  name: "Seed Academy",
  description: null,
  logoUrl: null,
  institutionType: "university",
  personalOwnerUsername: null,
};

const props = () => ({
  params: Promise.resolve({ institutionSlug: TYPED_SLUG }),
  searchParams: Promise.resolve({}),
});

const metadataProps = (slug: string = TYPED_SLUG) => ({
  params: Promise.resolve({ institutionSlug: slug }),
  searchParams: Promise.resolve({}),
});

const renderPage = async (userId: string | null) => {
  mockGetCurrentSession.mockResolvedValue(
    userId === null ? null : { user: { id: userId, role: "recruiter" } },
  );
  mockIsInstitutionAdminBySlug.mockImplementation(
    async (cookieUserId: string, slug: string) =>
      slug === NORMALISED_SLUG && MEMBER_USER_IDS.has(cookieUserId),
  );
  mockGetPublicInstitution.mockResolvedValue(INSTITUTION);
  mockLoadVerificationSummary.mockResolvedValue({
    institutionId: "institution_seed",
    institutionType: "university",
    verificationStatus: "verified",
    displayName: "Seed Academy",
  });
  mockResolveChargingReadiness.mockResolvedValue({ ready: true, blockers: [] });
  mockListPublicCompetitions.mockResolvedValue({ data: [] });

  const element = await InstitutionHubPage(props());
  return renderToStaticMarkup(element);
};

describe("InstitutionHubPage — which surface the URL segment selects", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("gives an institution owner the hub on the uppercased URL", async () => {
    const html = await renderPage("user_owner");

    expect(html).toContain("institution-hub-page");
    expect(html).not.toContain("PUBLIC_VIEW");
    expect(mockIsInstitutionAdminBySlug).toHaveBeenCalledWith("user_owner", NORMALISED_SLUG);
  });

  it("gives an institution staff member the hub on the uppercased URL", async () => {
    const html = await renderPage("user_staff");

    expect(html).toContain("institution-hub-page");
    expect(html).not.toContain("PUBLIC_VIEW");
    expect(mockIsInstitutionAdminBySlug).toHaveBeenCalledWith("user_staff", NORMALISED_SLUG);
  });

  it("gives a non-member the public view on the uppercased URL", async () => {
    const html = await renderPage(NON_MEMBER_USER_ID);

    expect(html).toContain(`PUBLIC_VIEW:${NORMALISED_SLUG}`);
    expect(html).not.toContain("institution-hub-page");
  });

  it.each(["ab", "!!!"])("is not found for %o, which is not a usable slug", async (slug) => {
    mockNotFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    const element = InstitutionHubPage({
      params: Promise.resolve({ institutionSlug: slug }),
      searchParams: Promise.resolve({}),
    });

    await expect(element).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockIsInstitutionAdminBySlug).not.toHaveBeenCalled();
    expect(mockGetPublicInstitution).not.toHaveBeenCalled();
  });
});

describe("generateMetadata — the address it declares", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("declares the normalised slug as canonical for the uppercased URL, and gives Open Graph the same address", async () => {
    mockGetPublicInstitution.mockResolvedValue(INSTITUTION);
    mockIsIndexableInstitution.mockReturnValue(true);

    const metadata = await generateMetadata(metadataProps());

    expect(metadata.alternates?.canonical).toBe(`/institution/${NORMALISED_SLUG}`);
    expect(metadata.openGraph?.url).toBe(`/institution/${NORMALISED_SLUG}`);
  });

  it("declares no canonical and no Open Graph for a slug that is not usable", async () => {
    mockGetPublicInstitution.mockResolvedValue(INSTITUTION);

    const metadata = await generateMetadata(metadataProps("!!!"));

    expect(metadata.title).toBe("Institusi tidak ditemukan · Lombakita");
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).toBeUndefined();
    expect(mockGetPublicInstitution).not.toHaveBeenCalled();
  });
});
