// @vitest-environment node

import type { Session } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getServerSessionMock, confirmOrganizationEmailCodeMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn<() => Promise<Session | null>>(),
  confirmOrganizationEmailCodeMock: vi.fn(),
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
    confirmOrganizationEmailCode: confirmOrganizationEmailCodeMock,
  };
});

import { POST } from "@/app/api/v1/me/organization-email/confirm/route";
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
  new Request("http://localhost/api/v1/me/organization-email/confirm", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];

describe("POST organization email confirm", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    getServerSessionMock.mockResolvedValue(null);

    const response = await POST(buildRequest({ code: "123456" }));

    expect(response.status).toBe(401);
    expect(confirmOrganizationEmailCodeMock).not.toHaveBeenCalled();
  });

  it.each(["platform_ops", "finance_ops", "reviewer_or_judge"] as const)(
    "refuses a %s session and confirms nothing",
    async (role) => {
      getServerSessionMock.mockResolvedValue(buildSession({ role, verifiedRoles: [] }));

      const response = await POST(
        buildRequest({ code: "123456" }, { [SESSION_USER_HEADER]: "u_1" }),
      );

      expect(response.status).toBe(403);
      expect(confirmOrganizationEmailCodeMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a mismatched expected user before confirming", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    const response = await POST(
      buildRequest({ code: "123456" }, { [SESSION_USER_HEADER]: "someone_else" }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("session_user_mismatch");
    expect(confirmOrganizationEmailCodeMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_payload when the code is not six digits", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    for (const body of [{ code: "12345" }, { code: "abcdef" }]) {
      const response = await POST(buildRequest(body, { [SESSION_USER_HEADER]: "u_1" }));

      expect(response.status).toBe(400);
    }
    expect(confirmOrganizationEmailCodeMock).not.toHaveBeenCalled();
  });

  it("confirms the code for the signed-in account", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    confirmOrganizationEmailCodeMock.mockResolvedValue({
      email: "budi@acme.example",
      trustSource: "organization_email",
    });

    const response = await POST(
      buildRequest({ code: " 123456 " }, { [SESSION_USER_HEADER]: "u_1" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      organizationEmail: { email: "budi@acme.example", trustSource: "organization_email" },
    });
    expect(confirmOrganizationEmailCodeMock).toHaveBeenCalledTimes(1);
    expect(confirmOrganizationEmailCodeMock).toHaveBeenCalledWith("u_1", "123456");
  });

  it("passes a wrong code through with the tries left", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    confirmOrganizationEmailCodeMock.mockRejectedValue(
      new OrganizationEmailError(
        "organization_email_code_invalid",
        422,
        "Kode tidak cocok. Sisa percobaan: 3.",
        { attemptsLeft: 3 },
      ),
    );

    const response = await POST(buildRequest({ code: "123456" }, { [SESSION_USER_HEADER]: "u_1" }));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.details.attemptsLeft).toBe(3);
  });
});
