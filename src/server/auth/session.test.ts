// @vitest-environment node

import type { Session } from "next-auth";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRole } from "@/lib/access/roles";

const state = vi.hoisted(() => ({
  account: {
    role: "platform_ops" as string | null,
    status: "active",
    suspendedAt: null as Date | null,
    mfaInvalidatedAt: null,
    hasVerifiedMfaFactor: false,
  },
  token: {} as Record<string, unknown>,
  query: vi.fn(),
  reader: vi.fn(),
  registrations: vi.fn(),
  participation: vi.fn(),
  readiness: vi.fn(),
  limiter: vi.fn(),
}));

// Keep JWT refresh, live account projection, session normalization and both guards real.
// Only the cookie boundary and database transport are replaced in this unit suite.
vi.mock("next-auth", () => ({
  getServerSession: async (options: {
    callbacks: {
      jwt: (args: unknown) => Promise<Record<string, unknown>>;
      session: (args: unknown) => Promise<Session>;
    };
  }) => {
    if (!state.token.sub) return null;
    const token = await options.callbacks.jwt({ token: { ...state.token } });
    return options.callbacks.session({ session: { user: {}, expires: "2099-01-01" }, token });
  },
}));
vi.mock("@/config/env.server", () => ({ assertRuntimeEnv: vi.fn(), serverEnv: {} }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/server/auth/credentials-auth", () => ({
  authenticateWithEmailPassword: vi.fn(),
  normalizeEmail: vi.fn(),
}));
vi.mock("@/server/auth/oauth-account", () => ({
  authorizeOAuthFinalize: vi.fn(),
  resolveGoogleOAuthSignIn: vi.fn(),
  GOOGLE_PROVIDER_ID: "google",
  OAUTH_FINALIZE_PROVIDER_ID: "oauth-finalize",
}));
vi.mock("@/server/auth/mfa/mfa-elevation", () => ({ consumeMfaElevationGrant: vi.fn() }));
vi.mock("@/server/redis/rate-limit", () => ({
  clearFailedAttempts: vi.fn(),
  isFailedAttemptLimited: vi.fn(),
  recordFailedAttempt: vi.fn(),
  checkFixedWindowLimitFailClosed: state.limiter,
}));
vi.mock("@/server/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: state.query,
        }),
      }),
    }),
  }),
}));
vi.mock("@/server/competitions/competition-service", () => ({
  getCompetitionForReader: state.reader,
  updateCompetitionDraft: vi.fn(),
  softDeleteCompetitionDraft: vi.fn(),
}));
vi.mock("@/server/competitions/competition-access", () => ({
  hasActiveRegistrationsForCompetition: state.registrations,
}));
vi.mock("@/server/competitions/competition-participation-service", () => ({
  getCompetitionParticipationSummary: state.participation,
}));
vi.mock("@/server/competitions/competition-publish-readiness", () => ({
  resolveCompetitionPublishReadiness: state.readiness,
}));

import {
  getCurrentSession,
  requireAuthenticatedSession as requireSession,
  requireSessionRole,
} from "./session";
import { withApiRole } from "./api-guard";
import { withMfaRouteAuth } from "./mfa/mfa-route-guard";
import { GET } from "@/app/api/v1/competitions/[competitionId]/route";

// The tests-only commit must typecheck against the old zero-argument API so CI reaches
// the behavioral failures, rather than stopping at a signature that has not landed yet.
const requireAuthenticatedSession = requireSession as (options?: {
  allowUnsatisfiedMfa?: boolean;
}) => ReturnType<typeof requireSession>;

const stageAccount = (
  role: AppRole,
  status: "enrolment_required" | "challenge_required" | "satisfied",
) => {
  state.account.role = role;
  state.account.hasVerifiedMfaFactor = status !== "enrolment_required";
  state.token = {
    sub: "actor",
    role,
    verifiedRoles: [],
    ...(status === "satisfied" ? { mfaVerifiedAt: Math.floor(Date.now() / 1000) } : {}),
  };
};
const operators = ["platform_ops", "finance_ops"] as const;
const unfinished = ["enrolment_required", "challenge_required"] as const;
const matrix = operators.flatMap((role) => unfinished.map((status) => ({ role, status })));
const request = () => new NextRequest("http://localhost/api/v1/auth/mfa/challenge");

beforeEach(() => {
  vi.clearAllMocks();
  state.query.mockReset();
  state.query.mockImplementation(async () => [state.account]);
  state.account.status = "active";
  state.account.suspendedAt = null;
  stageAccount("platform_ops", "enrolment_required");
  state.limiter.mockResolvedValue({ decision: "allowed" });
  state.reader.mockResolvedValue({ id: "competition", status: "draft" });
  state.registrations.mockResolvedValue(false);
  state.participation.mockResolvedValue({ state: "not_configured" });
  state.readiness.mockResolvedValue({ canPublish: false, blockers: [] });
});

describe("requireAuthenticatedSession secure default", () => {
  it.each(matrix)(
    "refuses $role with $status from the production session callbacks",
    async ({ role, status }) => {
      stageAccount(role, status);
      await expect(requireAuthenticatedSession()).rejects.toMatchObject({
        status: 403,
        code: `mfa_${status}`,
      });
    },
  );
  it.each(operators)("returns a satisfied %s", async (role) => {
    stageAccount(role, "satisfied");
    await expect(requireAuthenticatedSession()).resolves.toMatchObject({
      user: { role, mfaStatus: "satisfied" },
    });
  });
  it.each(["candidate", "recruiter"] as const)("returns a self-service %s", async (role) => {
    stageAccount(role, "enrolment_required");
    await expect(requireAuthenticatedSession()).resolves.toMatchObject({
      user: { role, mfaStatus: "not_applicable" },
    });
  });
  it("refuses a suspended candidate", async () => {
    stageAccount("candidate", "enrolment_required");
    state.account.suspendedAt = new Date();
    await expect(requireAuthenticatedSession()).rejects.toMatchObject({
      status: 403,
      code: "account_suspended",
    });
  });
  it("refuses a retained token whose live account is deactivated and roleless", async () => {
    state.account.status = "deactivated";
    await expect(requireAuthenticatedSession()).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
  });
  it.each(matrix)(
    "explicitly allows $role with $status for MFA lifecycle access",
    async ({ role, status }) => {
      stageAccount(role, status);
      await expect(
        requireAuthenticatedSession({ allowUnsatisfiedMfa: true }),
      ).resolves.toMatchObject({ user: { role, mfaStatus: status } });
    },
  );
});

describe("requireSessionRole precedence", () => {
  it.each(unfinished)("refuses the wrong role before disclosing %s", async (status) => {
    stageAccount("platform_ops", status);
    await expect(requireSessionRole(["candidate"])).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    const handler = vi.fn();
    const response = await withApiRole(["candidate"], handler)(request());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(unfinished)("refuses a held role with %s using the MFA code", async (status) => {
    stageAccount("platform_ops", status);
    await expect(requireSessionRole(["platform_ops"])).rejects.toMatchObject({
      status: 403,
      code: `mfa_${status}`,
    });
  });
});

describe("withMfaRouteAuth lifecycle access", () => {
  it.each(matrix)("runs the handler for $role with $status", async ({ role, status }) => {
    stageAccount(role, status);
    const handler = vi.fn(() => new Response(null, { status: 204 }));
    expect((await withMfaRouteAuth(handler)(request())).status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });
  it.each(["suspended", "deactivated"])("rejects a %s account before the handler", async (kind) => {
    if (kind === "suspended") {
      stageAccount("candidate", "enrolment_required");
      state.account.suspendedAt = new Date();
    } else state.account.status = "deactivated";
    const handler = vi.fn();
    const response = await withMfaRouteAuth(handler)(request());
    expect(response.status).toBe(kind === "suspended" ? 403 : 401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: kind === "suspended" ? "account_suspended" : "unauthenticated" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(state.limiter).not.toHaveBeenCalled();
  });
});

describe("competition GET through the real session guard", () => {
  it.each(matrix)(
    "refuses before every reader for $role with $status",
    async ({ role, status }) => {
      stageAccount(role, status);
      const response = await GET(request(), {
        params: Promise.resolve({ competitionId: "competition" }),
      });
      expect(state.reader).not.toHaveBeenCalled();
      expect(state.registrations).not.toHaveBeenCalled();
      expect(state.participation).not.toHaveBeenCalled();
      expect(state.readiness).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: `mfa_${status}` } });
    },
  );
  it("allows a satisfied platform operator to read", async () => {
    stageAccount("platform_ops", "satisfied");
    const response = await GET(request(), {
      params: Promise.resolve({ competitionId: "competition" }),
    });
    expect(response.status).toBe(200);
    expect(state.reader).toHaveBeenCalledWith("actor", "platform_ops", "competition");
    await expect(response.json()).resolves.toMatchObject({ competition: { id: "competition" } });
  });
});

describe("unavailable account state through real callbacks and getCurrentSession", () => {
  it.each(["candidate", "recruiter", "platform_ops", "finance_ops", "reviewer_or_judge"] as const)(
    "refuses %s with 503 after both live reads reject",
    async (role) => {
      stageAccount(role, "satisfied");
      state.query.mockRejectedValue(new Error("database unavailable"));
      await expect(getCurrentSession()).rejects.toMatchObject({
        code: "account_state_unavailable",
        status: 503,
        message: "Account status is temporarily unavailable",
      });
      expect(state.query).toHaveBeenCalledTimes(2);
      expect(state.token.sub).toBe("actor");
    },
  );
  it("returns null without reading the database when there is no session token", async () => {
    state.token = {};
    await expect(getCurrentSession()).resolves.toBeNull();
    expect(state.query).not.toHaveBeenCalled();
  });
  it("returns an API 503 without running the protected handler", async () => {
    stageAccount("candidate", "satisfied");
    state.query.mockRejectedValue(new Error("database unavailable"));
    const handler = vi.fn(() => new Response(null, { status: 204 }));
    const response = await withApiRole(["candidate"], handler)(request());
    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "account_state_unavailable" },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
