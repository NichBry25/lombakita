// @vitest-environment node

import type { Session } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getServerSessionMock, issueOrganizationEmailCodeMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn<() => Promise<Session | null>>(),
  issueOrganizationEmailCodeMock: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: getServerSessionMock,
}));

vi.mock("@/server/auth/auth.config", () => ({
  authOptions: {},
}));

vi.mock("@/server/host-trust/organization-email-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/host-trust/organization-email-service")>();
  return {
    ...actual,
    issueOrganizationEmailCode: issueOrganizationEmailCodeMock,
  };
});

import { POST } from "@/app/api/v1/me/organization-email/code/route";
import { OrganizationEmailError } from "@/server/host-trust/organization-email-service";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

const buildSession = (overrides: Partial<Session["user"]> = {}): Session =>
  ({
    user: {
      id: "u_1",
      email: "u@example.com",
      role: "candidate",
      verifiedRoles: ["candidate"],
      ...overrides,
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  }) as Session;

const buildRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/v1/me/organization-email/code", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];

describe("POST organization email code", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    getServerSessionMock.mockResolvedValue(null);

    const response = await POST(buildRequest({ email: "budi@acme.example" }));

    expect(response.status).toBe(401);
    expect(issueOrganizationEmailCodeMock).not.toHaveBeenCalled();
  });

  it.each(["platform_ops", "finance_ops", "reviewer_or_judge"] as const)(
    "refuses a %s session and sends nothing",
    async (role) => {
      getServerSessionMock.mockResolvedValue(buildSession({ role, verifiedRoles: [] }));

      const response = await POST(
        buildRequest({ email: "budi@acme.example" }, { [SESSION_USER_HEADER]: "u_1" }),
      );

      expect(response.status).toBe(403);
      expect(issueOrganizationEmailCodeMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a mismatched expected user before sending", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    const response = await POST(
      buildRequest({ email: "budi@acme.example" }, { [SESSION_USER_HEADER]: "someone_else" }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("session_user_mismatch");
    expect(issueOrganizationEmailCodeMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_payload when the email field is missing", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    const response = await POST(buildRequest({}, { [SESSION_USER_HEADER]: "u_1" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_payload");
    expect(issueOrganizationEmailCodeMock).not.toHaveBeenCalled();
  });

  it("sends the code for the signed-in account and returns its expiry", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    issueOrganizationEmailCodeMock.mockResolvedValue({
      email: "budi@acme.example",
      expiresAt: new Date("2026-11-25T00:10:00.000Z"),
    });

    const response = await POST(
      buildRequest({ email: "budi@acme.example" }, { [SESSION_USER_HEADER]: "u_1" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      organizationEmailCode: {
        email: "budi@acme.example",
        expiresAt: "2026-11-25T00:10:00.000Z",
      },
    });
    expect(issueOrganizationEmailCodeMock).toHaveBeenCalledTimes(1);
    expect(issueOrganizationEmailCodeMock).toHaveBeenCalledWith("u_1", "budi@acme.example");
  });

  it("passes a refusal through with its code, status and wait", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    issueOrganizationEmailCodeMock.mockRejectedValue(
      new OrganizationEmailError(
        "organization_email_resend_too_soon",
        429,
        "Tunggu 42 detik sebelum meminta kode baru.",
        { retryAfterSeconds: 42 },
      ),
    );

    const response = await POST(
      buildRequest({ email: "budi@acme.example" }, { [SESSION_USER_HEADER]: "u_1" }),
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("organization_email_resend_too_soon");
    expect(body.error.details.retryAfterSeconds).toBe(42);
  });
});
