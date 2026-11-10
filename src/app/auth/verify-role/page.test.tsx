// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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
