// @vitest-environment node

import type { Session } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getServerSessionMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn<() => Promise<Session | null>>(),
}));

vi.mock("next-auth", () => ({
  getServerSession: getServerSessionMock,
}));

vi.mock("@/server/auth/auth.config", () => ({
  authOptions: {},
}));

import { GET as candidateOnly } from "@/app/api/v1/me/candidate-only/route";
import { GET as recruiterOnly } from "@/app/api/v1/me/recruiter-only/route";

const buildSession = (role: string): Session =>
  ({
    user: { id: "u_1", email: "u@example.com", role },
    expires: new Date(Date.now() + 60_000).toISOString(),
  }) as Session;

const fakeRequest = () =>
  new Request("http://localhost/api/v1/me/candidate-only", { method: "GET" }) as unknown as never;

describe("Rollback Step 1.3 minimal-proof role-gated endpoints", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("candidate-only endpoint: 200 for a candidate session", async () => {
    getServerSessionMock.mockResolvedValue(buildSession("candidate"));

    const response = await candidateOnly(fakeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accessed).toBe("candidate-only");
  });

  it("candidate-only endpoint: 403 for a recruiter session", async () => {
    getServerSessionMock.mockResolvedValue(buildSession("recruiter"));

    const response = await candidateOnly(fakeRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  it("recruiter-only endpoint: 200 for a recruiter session", async () => {
    getServerSessionMock.mockResolvedValue(buildSession("recruiter"));

    const response = await recruiterOnly(fakeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accessed).toBe("recruiter-only");
  });

  it("recruiter-only endpoint: 403 for a candidate session", async () => {
    getServerSessionMock.mockResolvedValue(buildSession("candidate"));

    const response = await recruiterOnly(fakeRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects unauthenticated callers with 401", async () => {
    getServerSessionMock.mockResolvedValue(null);

    const response = await candidateOnly(fakeRequest());

    expect(response.status).toBe(401);
  });

  it("rejects sessions carrying legacy 'student' token with 401", async () => {
    // Pre-rollback JWT contamination scenario: if a stale token bearing role='student' somehow
    // passes signature validation (AUTH_SECRET not yet rotated), normalizeSessionRole still
    // fails-clean. The role-gate never silently coerces to candidate.
    getServerSessionMock.mockResolvedValue(buildSession("student"));

    const response = await candidateOnly(fakeRequest());

    expect(response.status).toBe(401);
  });

  it("rejects sessions carrying legacy 'institution_admin' token with 401", async () => {
    getServerSessionMock.mockResolvedValue(buildSession("institution_admin"));

    const response = await recruiterOnly(fakeRequest());

    expect(response.status).toBe(401);
  });
});
