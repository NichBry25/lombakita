// @vitest-environment node

import type { Session } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const { redirectMock, getCurrentSessionMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((): never => {
    throw new Error("NEXT_REDIRECT");
  }),
  getCurrentSessionMock: vi.fn<() => Promise<Session | null>>(),
}));

vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: getCurrentSessionMock }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { requireRolePage } from "@/server/auth/page-guard";
import { SELF_SERVICE_ROLES } from "@/lib/access/roles";
import { VERIFIABLE_ROLES } from "@/server/auth/role-verification";

// The page gate on /auth/verify-role tests SELF_SERVICE_ROLES while its completion endpoint gates
// on VERIFIABLE_ROLES. Extending one without the other would let an account reach a form it is
// then refused at, or worse, gate the form more loosely than the write.
describe("self-service and verifiable role lists", () => {
  it("stay identical so the verify-role page and its endpoint cannot disagree", () => {
    expect([...VERIFIABLE_ROLES].sort()).toEqual([...SELF_SERVICE_ROLES].sort());
  });
});

const buildSession = (user: Partial<NonNullable<Session["user"]>>): Session =>
  ({
    user: { id: "u_1", email: "u@example.com", ...user },
    expires: new Date(Date.now() + 60_000).toISOString(),
  }) as Session;

describe("requireRolePage", () => {
  afterEach(() => vi.clearAllMocks());

  it("sends an unauthenticated visitor to login carrying the callback path", async () => {
    getCurrentSessionMock.mockResolvedValue(null);

    await expect(
      requireRolePage("candidate", { callbackPath: "/candidate-dashboard/results" }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith(
      "/auth/login?callbackUrl=%2Fcandidate-dashboard%2Fresults",
    );
  });

  it("returns the session when the active role matches", async () => {
    getCurrentSessionMock.mockResolvedValue(
      buildSession({ role: "candidate", verifiedRoles: ["candidate"] }),
    );

    const result = await requireRolePage("candidate", { callbackPath: "/saved" });

    expect(result.user.id).toBe("u_1");
    expect(result.user.role).toBe("candidate");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns the session for a dual-verified account acting under its other role", async () => {
    getCurrentSessionMock.mockResolvedValue(
      buildSession({ role: "recruiter", verifiedRoles: ["recruiter", "candidate"] }),
    );

    const result = await requireRolePage("candidate", { callbackPath: "/saved" });

    expect(result.user.id).toBe("u_1");
    expect(result.user.role).toBe("recruiter");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("sends a self-service account missing the role to the configured onboarding path", async () => {
    getCurrentSessionMock.mockResolvedValue(
      buildSession({ role: "candidate", verifiedRoles: ["candidate"] }),
    );

    await expect(
      requireRolePage("recruiter", {
        callbackPath: "/recruiter-dashboard",
        missingRoleRedirect: "/auth/verify-role?as=recruiter",
      }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/auth/verify-role?as=recruiter");
  });

  it("defaults a self-service account missing the role to the home page", async () => {
    getCurrentSessionMock.mockResolvedValue(
      buildSession({ role: "candidate", verifiedRoles: ["candidate"] }),
    );

    await expect(
      requireRolePage("recruiter", { callbackPath: "/institution/acme" }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  // Every account is created as a candidate or recruiter before promotion, so an operational
  // account's verifiedRoles still names a participant role. The guard must not fold it in — and
  // must not offer onboarding either, which would invite the account to collect a second role.
  it.each([
    ["platform_ops", "/admin"],
    ["finance_ops", "/"],
    ["reviewer_or_judge", "/"],
  ] as const)(
    "refuses a %s session holding a participant verification, and never offers onboarding",
    async (role, expectedDestination) => {
      getCurrentSessionMock.mockResolvedValue(
        buildSession({ role, verifiedRoles: ["candidate", "recruiter"] }),
      );

      await expect(
        requireRolePage("candidate", {
          callbackPath: "/candidate-dashboard",
          missingRoleRedirect: "/auth/verify-role?as=candidate",
        }),
      ).rejects.toThrow("NEXT_REDIRECT");

      expect(redirectMock).toHaveBeenCalledWith(expectedDestination);
      expect(redirectMock).not.toHaveBeenCalledWith("/auth/verify-role?as=candidate");
    },
  );

  it("sends a session carrying a stale role token back to login for a fresh token", async () => {
    // "student" is a retired pre-rollback token that can still ride in a signature-valid JWT.
    getCurrentSessionMock.mockResolvedValue(
      buildSession({ role: "student" as never, verifiedRoles: ["candidate"] }),
    );

    await expect(
      requireRolePage("candidate", { callbackPath: "/candidate-dashboard" }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/auth/login?callbackUrl=%2Fcandidate-dashboard");
  });

  // Page renders, not just mutations: a suspended account holding a live cookie must stop seeing
  // participant names and emails immediately, not when its cookie expires.
  it("sends a suspended account to /suspended instead of rendering the page", async () => {
    getCurrentSessionMock.mockResolvedValue(
      buildSession({
        role: "recruiter",
        verifiedRoles: ["recruiter"],
        suspendedAt: new Date().toISOString(),
      } as never),
    );

    await expect(
      requireRolePage("recruiter", {
        callbackPath: "/institution/acme/competitions/x/participants",
      }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/suspended");
  });

  it("blocks a suspended account even when it holds the required role", async () => {
    getCurrentSessionMock.mockResolvedValue(
      buildSession({
        role: "candidate",
        verifiedRoles: ["candidate"],
        suspendedAt: new Date().toISOString(),
      } as never),
    );

    await expect(requireRolePage("candidate", { callbackPath: "/saved" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(redirectMock).toHaveBeenCalledWith("/suspended");
    expect(redirectMock).not.toHaveBeenCalledWith("/");
  });
});
