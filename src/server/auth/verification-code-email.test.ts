// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveEmailDelivery: vi.fn(),
  sendMail: vi.fn(),
  serverEnv: { appEnv: "test" as string, emailDeliveryEnabled: false },
}));

vi.mock("@/config/env.server", () => ({ serverEnv: mocks.serverEnv }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/email/delivery", () => ({ resolveEmailDelivery: mocks.resolveEmailDelivery }));
vi.mock("@/server/email/smtp-transport", () => ({
  buildResendSmtpTransport: () => ({ sendMail: mocks.sendMail }),
}));

import { logger } from "@/lib/logger";
import { sendRegistrationVerificationEmail } from "@/server/auth/email-verification";

const DELIVERY = { apiKey: "key", from: "noreply@lombakita.test" };
const EMAIL = "rina.code@example.test";
const CODE = "042917";

const sentMessage = () => mocks.sendMail.mock.calls[0]![0] as Record<string, string>;

const everyLoggerCall = (): unknown[][] => [
  ...vi.mocked(logger.info).mock.calls,
  ...vi.mocked(logger.warn).mock.calls,
  ...vi.mocked(logger.error).mock.calls,
];

afterEach(() => {
  vi.clearAllMocks();
  mocks.serverEnv.emailDeliveryEnabled = false;
});

describe("the verification code email", () => {
  it("sends the code with a plain greeting and the warning line", async () => {
    mocks.resolveEmailDelivery.mockReturnValue(DELIVERY);
    mocks.serverEnv.emailDeliveryEnabled = true;

    await sendRegistrationVerificationEmail({ email: EMAIL, code: CODE });

    const message = sentMessage();
    for (const part of [message.text, message.html]) {
      expect(part).toContain("Halo,");
      expect(part).toContain(CODE);
      expect(part).toContain("10 menit");
      expect(part).toContain("Jika Anda tidak meminta kode ini, abaikan email ini.");
      expect(part).not.toContain("http");
      expect(part).not.toContain("Rina");
    }
  });

  it("logs the code only where delivery is switched off", async () => {
    mocks.resolveEmailDelivery.mockReturnValue(null);
    mocks.serverEnv.emailDeliveryEnabled = false;

    await sendRegistrationVerificationEmail({ email: EMAIL, code: CODE });

    expect(logger.info).toHaveBeenCalledWith("auth.registration_code.delivery_suppressed", {
      email: EMAIL,
      code: CODE,
    });
  });

  it("never logs the code where delivery is on", async () => {
    mocks.resolveEmailDelivery.mockReturnValue(null);
    mocks.serverEnv.emailDeliveryEnabled = true;

    await sendRegistrationVerificationEmail({ email: EMAIL, code: CODE });

    const loggedCode = everyLoggerCall().some((call) => JSON.stringify(call).includes(CODE));
    expect(loggedCode).toBe(false);
  });
});
