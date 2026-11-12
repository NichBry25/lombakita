// @vitest-environment node

import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getRedirectError } from "next/dist/client/components/redirect";

const { verifyRegistrationEmailToken, loggerErrorMock } = vi.hoisted(() => ({
  verifyRegistrationEmailToken: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href, ...rest }: { children: unknown; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: loggerErrorMock, info: vi.fn() },
}));

vi.mock("@/server/auth/credentials-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/credentials-auth")>();

  return {
    ...actual,
    verifyRegistrationEmailToken,
  };
});

import VerifyEmailPage from "@/app/auth/verify-email/page";
import { CredentialsAuthError } from "@/server/auth/credentials-auth";

async function renderPage(): Promise<string> {
  const page = await VerifyEmailPage({ searchParams: Promise.resolve({ token: "token-1" }) });
  return renderToStaticMarkup(page);
}

describe("VerifyEmailPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("logs an unexpected failure without its message and shows the fixed sentence", async () => {
    verifyRegistrationEmailToken.mockRejectedValue(new Error("Failed query: select secret-query"));

    const html = await renderPage();

    expect(html).toContain("Terjadi kesalahan tak terduga saat memverifikasi akun.");
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "route.unexpected_error",
      expect.objectContaining({ where: "email verification" }),
    );
    expect(inspect(loggerErrorMock.mock.calls, { depth: null })).not.toContain("secret-query");
  });

  it("shows the Indonesian refusal for an invalid token and does not log it", async () => {
    verifyRegistrationEmailToken.mockRejectedValue(
      new CredentialsAuthError("verification_token_invalid", 400, "English server secret"),
    );

    const html = await renderPage();

    expect(html).toContain("Tautan verifikasi tidak valid atau sudah dipakai.");
    expect(html).not.toContain("English server secret");
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});

const redirectDigest = (path: string): string => getRedirectError(path, "replace").digest;

const redirectDigestOf = async (searchParams: { token?: string; callbackUrl?: string }) => {
  try {
    await VerifyEmailPage({ searchParams: Promise.resolve(searchParams) });
  } catch (error) {
    return (error as { digest?: string }).digest;
  }
  return undefined;
};

describe("VerifyEmailPage return address", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends a verified account to sign-in with its email and return address", async () => {
    verifyRegistrationEmailToken.mockResolvedValue({
      email: "budi@example.com",
      status: "verified",
    });

    const digest = await redirectDigestOf({
      token: "token-1",
      callbackUrl: "/competitions/acme/lomba-1",
    });

    expect(digest).toBe(
      redirectDigest(
        "/auth/login?verified=1&email=budi%40example.com&callbackUrl=%2Fcompetitions%2Facme%2Flomba-1",
      ),
    );
  });

  it("drops a return address to another site", async () => {
    verifyRegistrationEmailToken.mockResolvedValue({
      email: "budi@example.com",
      status: "verified",
    });

    const digest = await redirectDigestOf({ token: "token-1", callbackUrl: "//example.com" });

    expect(digest).toBe(redirectDigest("/auth/login?verified=1&email=budi%40example.com"));
  });

  it("keeps the return address on the way back to sign-in", async () => {
    const page = await VerifyEmailPage({
      searchParams: Promise.resolve({ callbackUrl: "/competitions/acme/lomba-1" }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('href="/auth/login?callbackUrl=%2Fcompetitions%2Facme%2Flomba-1"');
  });
});
