// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetCurrentSession, mockRedirect } = vi.hoisted(() => ({
  mockGetCurrentSession: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: mockGetCurrentSession }));
vi.mock("@/components/institution/institution-workspace-shell", () => ({
  InstitutionWorkspaceShell: () => null,
}));

import InstitutionCreatePage from "./page";

describe("InstitutionCreatePage — session guard redirects", () => {
  afterEach(() => vi.clearAllMocks());

  it("redirects unauthenticated sessions to sign-in with a callbackUrl", async () => {
    mockGetCurrentSession.mockResolvedValue(null);
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(InstitutionCreatePage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/auth/login?callbackUrl="));
  });

  it("redirects a non-recruiter session to the recruiter role sign-up form, not the homepage", async () => {
    mockGetCurrentSession.mockResolvedValue({
      user: {
        id: "u_candidate",
        email: "c@example.com",
        role: "candidate",
        verifiedRoles: ["candidate"],
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    });
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(InstitutionCreatePage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/auth/verify-role?as=recruiter");
  });

  it("renders the workspace shell for a verified recruiter session (no redirect)", async () => {
    mockGetCurrentSession.mockResolvedValue({
      user: {
        id: "u_recruiter",
        email: "r@example.com",
        role: "recruiter",
        verifiedRoles: ["recruiter"],
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await InstitutionCreatePage();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
