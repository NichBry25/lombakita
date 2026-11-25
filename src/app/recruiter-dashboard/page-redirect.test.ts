// @vitest-environment node

import type { Session } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  redirectMock,
  getCurrentSessionMock,
  getUnverifiedRolesMock,
  readHostStatusForAccountMock,
  listUserInstitutionMembershipsMock,
} = vi.hoisted(() => ({
  redirectMock: vi.fn((): never => {
    throw new Error("NEXT_REDIRECT");
  }),
  getCurrentSessionMock: vi.fn<() => Promise<Session | null>>(),
  getUnverifiedRolesMock: vi.fn(),
  readHostStatusForAccountMock: vi.fn(),
  listUserInstitutionMembershipsMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: getCurrentSessionMock }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/auth/role-verification", () => ({
  getUnverifiedRoles: getUnverifiedRolesMock,
}));
vi.mock("@/server/host-trust/host-check-service", () => ({
  readHostStatusForAccount: readHostStatusForAccountMock,
}));
vi.mock("@/server/institution-workspace/institution-service", () => ({
  listUserInstitutionMemberships: listUserInstitutionMembershipsMock,
}));
vi.mock("@/components/host/host-status-card", () => ({ HostStatusCard: () => null }));
vi.mock("@/components/auth/second-role-banner", () => ({ SecondRoleBanner: () => null }));

import RecruiterDashboardPage from "@/app/recruiter-dashboard/page";

const buildSession = (user: Partial<NonNullable<Session["user"]>>): Session =>
  ({
    user: { id: "u_1", email: "u@example.com", ...user },
    expires: new Date(Date.now() + 60_000).toISOString(),
  }) as Session;

// The guard under test is the real requireRolePage that the page calls, so the only input is the
// session.
describe("the host dashboard page guard", () => {
  afterEach(() => vi.clearAllMocks());

  it("sends a signed-in account without the host role to the host step", async () => {
    getCurrentSessionMock.mockResolvedValue(
      buildSession({ id: "user_participant", role: "candidate", verifiedRoles: ["candidate"] }),
    );

    await expect(RecruiterDashboardPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/auth/verify-role?as=recruiter");
    expect(getUnverifiedRolesMock).not.toHaveBeenCalled();
    expect(readHostStatusForAccountMock).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to sign-in with the host dashboard as the return address", async () => {
    getCurrentSessionMock.mockResolvedValue(null);

    await expect(RecruiterDashboardPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/auth/login?callbackUrl=%2Frecruiter-dashboard");
  });
});
