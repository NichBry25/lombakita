// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { candidateRoleOfferPath } from "@/app/competitions/[institutionSlug]/[slug]/candidate-role-offer-path";

const { mockRedirect, mockRequireActiveSessionPage, mockGetUnverifiedRoles, VerifyRoleForm } =
  vi.hoisted(() => ({
    mockRedirect: vi.fn((): never => {
      throw new Error("NEXT_REDIRECT");
    }),
    mockRequireActiveSessionPage: vi.fn(async () => ({
      user: { id: "user-42", role: "candidate" },
    })),
    mockGetUnverifiedRoles: vi.fn(async () => ["recruiter"]),
    VerifyRoleForm: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  }));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/server/auth/page-guard", () => ({
  requireActiveSessionPage: mockRequireActiveSessionPage,
}));
vi.mock("@/server/auth/role-verification", () => ({
  getUnverifiedRoles: mockGetUnverifiedRoles,
  isVerifiableRole: (role: string) => role === "candidate" || role === "recruiter",
  dashboardPathForRole: () => "/candidate-dashboard",
}));
vi.mock("./verify-role-form", () => ({ VerifyRoleForm }));

import VerifyRolePage from "@/app/auth/verify-role/page";

const RETURN_PATH = "/competitions/acme/lomba-1";

type PageParams = { as?: string; callbackUrl?: string };

const renderPage = async (searchParams: PageParams) =>
  renderToStaticMarkup(await VerifyRolePage({ searchParams: Promise.resolve(searchParams) }));

const signInAs = (role: string, unverified?: string[]) => {
  mockRequireActiveSessionPage.mockResolvedValueOnce({ user: { id: "user-42", role } });
  if (unverified) {
    mockGetUnverifiedRoles.mockResolvedValueOnce(unverified);
  }
};

const signInAsHost = (unverified: string[]) => signInAs("recruiter", unverified);

const lastFormProps = () => VerifyRoleForm.mock.calls.at(-1)?.[0];

afterEach(() => {
  vi.clearAllMocks();
});

describe("the role form page", () => {
  it("passes the signed-in account's id to the role form", async () => {
    renderToStaticMarkup(
      await VerifyRolePage({ searchParams: Promise.resolve({ as: "recruiter" }) }),
    );

    expect(VerifyRoleForm.mock.calls[0]?.[0]).toMatchObject({
      expectedUserId: "user-42",
      role: "recruiter",
    });
  });
});

describe("the role page return address", () => {
  it("hands the form a return address on this site", async () => {
    signInAsHost(["candidate"]);

    await renderPage({ as: "candidate", callbackUrl: RETURN_PATH });

    expect(lastFormProps()).toMatchObject({
      role: "candidate",
      expectedUserId: "user-42",
      returnPath: RETURN_PATH,
    });
  });

  it("hands the form no return address that leads off this site", async () => {
    const offSiteAddresses = [
      "//example.com",
      "/\\example.com",
      "https://example.com/competitions/acme/lomba-1",
      "/" + "a".repeat(512),
    ];

    for (const callbackUrl of offSiteAddresses) {
      signInAsHost(["candidate"]);

      await renderPage({ as: "candidate", callbackUrl });

      expect(lastFormProps()?.returnPath).toBeNull();
    }
  });

  it("reads the address the competition page's button carries", async () => {
    const href = candidateRoleOfferPath("recruiter", ["recruiter"], RETURN_PATH);
    const params = new URL(href ?? "", "https://lombakita.local").searchParams;
    signInAsHost(["candidate"]);

    await renderPage({
      as: params.get("as") ?? undefined,
      callbackUrl: params.get("callbackUrl") ?? undefined,
    });

    expect(lastFormProps()).toMatchObject({ role: "candidate", returnPath: RETURN_PATH });
  });

  it("sends an account that already holds the role back to the return address", async () => {
    signInAsHost([]);

    await expect(renderPage({ as: "candidate", callbackUrl: RETURN_PATH })).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(mockRedirect).toHaveBeenCalledWith(RETURN_PATH);
  });

  it("sends an account that already holds the role to its dashboard when the return address leads off this site", async () => {
    signInAsHost([]);

    await expect(renderPage({ as: "candidate", callbackUrl: "//example.com" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(mockRedirect).toHaveBeenCalledWith("/candidate-dashboard");
  });

  it("sends an operational account away without the role form", async () => {
    for (const role of ["platform_ops", "finance_ops", "reviewer_or_judge"]) {
      signInAs(role);

      await expect(renderPage({ as: "candidate", callbackUrl: RETURN_PATH })).rejects.toThrow(
        "NEXT_REDIRECT",
      );

      expect(mockRedirect).toHaveBeenLastCalledWith("/");
    }
    expect(VerifyRoleForm).not.toHaveBeenCalled();
    expect(mockGetUnverifiedRoles).not.toHaveBeenCalled();
  });

  it("returns Kembali to the return address", async () => {
    signInAsHost(["candidate"]);

    const html = await renderPage({ as: "candidate", callbackUrl: RETURN_PATH });

    expect(html).toContain('href="/competitions/acme/lomba-1"');
  });

  it("returns Kembali to the return address when the role is not named", async () => {
    signInAs("recruiter");

    const html = await renderPage({ callbackUrl: RETURN_PATH });

    expect(html).toContain('href="/competitions/acme/lomba-1"');
    expect(html).toContain("Satu akun dapat menjadi kandidat sekaligus penyelenggara.");
  });
});

describe("the role page words", () => {
  it("titles the candidate page Daftar sebagai kandidat", async () => {
    signInAsHost(["candidate"]);

    const html = await renderPage({ as: "candidate" });

    expect(html).toContain("<h1>Daftar sebagai kandidat</h1>");
    expect(html).toContain("Satu akun dapat menjadi kandidat sekaligus penyelenggara.");
  });

  it("titles the host page Daftar sebagai penyelenggara and calls no one rekruter", async () => {
    signInAs("candidate", ["recruiter"]);

    const html = await renderPage({ as: "recruiter" });

    expect(html).toContain("<h1>Daftar sebagai penyelenggara</h1>");
    expect(html).toContain(
      "Sebagai penyelenggara, Anda dapat menerbitkan dan mengelola kompetisi.",
    );
    expect(html).not.toMatch(/rekruter/i);
  });
});
