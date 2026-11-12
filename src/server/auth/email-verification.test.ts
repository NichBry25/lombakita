// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { serverEnv, mocks } = vi.hoisted(() => ({
  serverEnv: {
    resendApiKey: "re_test_key",
    authEmailFrom: "noreply@seed.lombakita.local",
    authUrl: "https://lombakita.local",
    appBaseUrl: undefined as string | undefined,
    emailDeliveryEnabled: true,
    appEnv: "test",
  },
  mocks: {
    resolveEmailDelivery: vi.fn(),
    sendMail: vi.fn(),
  },
}));

vi.mock("@/config/env.server", () => ({ serverEnv }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "https://lombakita.local" } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/email/delivery", () => ({ resolveEmailDelivery: mocks.resolveEmailDelivery }));
vi.mock("@/server/email/smtp-transport", () => ({
  buildResendSmtpTransport: () => ({ sendMail: mocks.sendMail }),
}));

import {
  buildVerificationUrl,
  sendRegistrationVerificationEmail,
} from "@/server/auth/email-verification";

const sentMessage = () => mocks.sendMail.mock.calls[0]![0] as Record<string, string>;

afterEach(() => {
  vi.clearAllMocks();
});

describe("the verification link", () => {
  it("adds the return address to the verification link", () => {
    expect(buildVerificationUrl("tok", "/competitions/acme/lomba-1")).toBe(
      "https://lombakita.local/auth/verify-email?token=tok&callbackUrl=%2Fcompetitions%2Facme%2Flomba-1",
    );
  });

  it("leaves the return address out when there is none", () => {
    expect(buildVerificationUrl("tok", null)).toBe(
      "https://lombakita.local/auth/verify-email?token=tok",
    );
  });
});

describe("the verification email", () => {
  it("puts the return address into the emailed link", async () => {
    mocks.resolveEmailDelivery.mockReturnValue({
      apiKey: "re_test_key",
      from: "noreply@seed.lombakita.local",
    });

    await sendRegistrationVerificationEmail({
      email: "candidate@seed.lombakita.local",
      name: "Dinda",
      rawToken: "tok",
      returnPath: "/competitions/acme/lomba-1",
    });

    const link =
      "https://lombakita.local/auth/verify-email?token=tok&callbackUrl=%2Fcompetitions%2Facme%2Flomba-1";
    const message = sentMessage();
    expect(message.html).toContain(link);
    expect(message.text).toContain(link);
  });

  it("writes the person's name into the email as text, not markup", async () => {
    mocks.resolveEmailDelivery.mockReturnValue({
      apiKey: "re_test_key",
      from: "noreply@seed.lombakita.local",
    });

    await sendRegistrationVerificationEmail({
      email: "candidate@seed.lombakita.local",
      name: '<a href="https://example.com">x</a>',
      rawToken: "tok",
      returnPath: "/competitions/acme/lomba-1",
    });

    const message = sentMessage();
    expect(message.html).toContain("&lt;a href=&quot;https://example.com&quot;&gt;x&lt;/a&gt;");
    expect(message.html).not.toContain('<a href="https://example.com">');
  });
});
