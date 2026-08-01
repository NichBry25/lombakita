// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { mockFindOwnedPersonalInstitution, mockGetCurrentSession, mockRedirect } = vi.hoisted(
  () => ({
    mockFindOwnedPersonalInstitution: vi.fn(),
    mockGetCurrentSession: vi.fn(),
    mockRedirect: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: mockGetCurrentSession }));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  findOwnedPersonalInstitution: mockFindOwnedPersonalInstitution,
}));
vi.mock("@/components/institution/personal-institution-create-shell", () => ({
  PersonalInstitutionCreateShell: ({ expectedUserId }: { expectedUserId: string }) => (
    <div>CREATE_PERSONAL_INSTITUTION:{expectedUserId}</div>
  ),
}));

import PersonalInstitutionPage from "@/app/institution/personal/page";

const recruiterSession = {
  user: {
    id: "user_recruiter",
    role: "recruiter",
    verifiedRoles: ["recruiter"],
  },
};

describe("PersonalInstitutionPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects an unauthenticated visitor to login without looking up an institution", async () => {
    mockGetCurrentSession.mockResolvedValue(null);
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(PersonalInstitutionPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(mockRedirect).toHaveBeenCalledWith("/auth/login?callbackUrl=%2Finstitution%2Fpersonal");
    expect(mockFindOwnedPersonalInstitution).not.toHaveBeenCalled();
  });

  it("redirects a non-recruiter account without looking up an institution", async () => {
    mockGetCurrentSession.mockResolvedValue({
      user: {
        id: "user_candidate",
        role: "candidate",
        verifiedRoles: ["candidate"],
      },
    });
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(PersonalInstitutionPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(mockRedirect).toHaveBeenCalledWith("/");
    expect(mockFindOwnedPersonalInstitution).not.toHaveBeenCalled();
  });

  it("redirects a verified recruiter with a personal institution to its canonical route", async () => {
    mockGetCurrentSession.mockResolvedValue(recruiterSession);
    mockFindOwnedPersonalInstitution.mockResolvedValue({
      institutionId: "institution_personal",
      slug: "owner-username",
    });
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(PersonalInstitutionPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(mockFindOwnedPersonalInstitution).toHaveBeenCalledWith("user_recruiter");
    expect(mockRedirect).toHaveBeenCalledWith("/institution/owner-username");
  });

  it("renders the create surface when the verified recruiter has no personal institution", async () => {
    mockGetCurrentSession.mockResolvedValue(recruiterSession);
    mockFindOwnedPersonalInstitution.mockResolvedValue(null);

    const html = renderToStaticMarkup(await PersonalInstitutionPage());

    expect(html).toContain("CREATE_PERSONAL_INSTITUTION:user_recruiter");
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
