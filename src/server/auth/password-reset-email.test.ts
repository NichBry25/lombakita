// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANY } from "@/config/company";
import { EmailSendError } from "@/server/email/send-failure";

const mocks = vi.hoisted(() => ({
  resolveEmailDelivery: vi.fn(),
  sendMail: vi.fn(),
  serverEnv: { appEnv: "test" as string },
}));

vi.mock("@/config/env.server", () => ({ serverEnv: mocks.serverEnv }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/auth/email-verification", () => ({
  resolveBaseUrl: () => "https://lombakita.test",
}));
vi.mock("@/server/email/delivery", () => ({ resolveEmailDelivery: mocks.resolveEmailDelivery }));
vi.mock("@/server/email/smtp-transport", () => ({
  buildResendSmtpTransport: () => ({ sendMail: mocks.sendMail }),
}));

import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendPasswordResetGoogleNoticeEmail,
} from "@/server/auth/password-reset-email";

const DELIVERY = { apiKey: "key", from: "noreply@lombakita.test" };
const HOSTILE_NAME = `<script>alert("x")</script> & 'Ana'`;

const sentMessage = () => mocks.sendMail.mock.calls[0]![0] as Record<string, string>;

afterEach(() => {
  vi.clearAllMocks();
  mocks.serverEnv.appEnv = "test";
});

describe("password-recovery emails", () => {
  it("mails the reset link to the recipient and puts the token in the URL", async () => {
    mocks.resolveEmailDelivery.mockReturnValue(DELIVERY);

    await sendPasswordResetEmail({
      email: "ada@example.test",
      name: "Ada",
      rawToken: "t".repeat(64),
    });

    const message = sentMessage();
    expect(message.to).toBe("ada@example.test");
    expect(message.subject).toBe("Atur ulang password Lombakita");
    expect(message.text).toContain(
      `https://lombakita.test/auth/reset-password?token=${"t".repeat(64)}`,
    );
    expect(message.text).toContain("Tautan ini berlaku selama 30 menit");
    expect(message.html).toContain("Atur Ulang Password");
    expect(message.html).toContain("Atau gunakan tautan ini:");
    expect(mocks.resolveEmailDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "password_reset", to: "ada@example.test" }),
    );
  });

  it("escapes the display name in the HTML and leaves the plain text alone", async () => {
    mocks.resolveEmailDelivery.mockReturnValue(DELIVERY);

    await sendPasswordResetEmail({
      email: "ada@example.test",
      name: HOSTILE_NAME,
      rawToken: "t".repeat(64),
    });

    const message = sentMessage();
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Ana&#39;",
    );
    expect(message.text).toContain(HOSTILE_NAME);
  });

  it("sends the Google notice with a link to the sign-in page", async () => {
    mocks.resolveEmailDelivery.mockReturnValue(DELIVERY);

    await sendPasswordResetGoogleNoticeEmail({ email: "ada@example.test", name: "Ada" });

    const message = sentMessage();
    expect(message.subject).toBe("Akun Lombakita Anda masuk dengan Google");
    expect(message.text).toContain("https://lombakita.test/auth/login");
    expect(message.html).toContain("Buka Halaman Masuk");
  });

  it("sends the password-changed notice with the support address", async () => {
    mocks.resolveEmailDelivery.mockReturnValue(DELIVERY);

    await sendPasswordChangedEmail({ email: "ada@example.test", name: "Ada" });

    const message = sentMessage();
    expect(message.subject).toBe("Password Lombakita Anda berubah");
    expect(message.text).toContain("https://lombakita.test/auth/forgot-password");
    expect(message.text).toContain(COMPANY.supportEmail);
  });

  it("sends nothing when delivery is suppressed", async () => {
    mocks.resolveEmailDelivery.mockReturnValue(null);

    await sendPasswordChangedEmail({ email: "ada@example.test", name: "Ada" });

    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("rethrows a failed send as a classified EmailSendError carrying its kind", async () => {
    mocks.resolveEmailDelivery.mockReturnValue(DELIVERY);
    mocks.sendMail.mockRejectedValue(Object.assign(new Error("refused"), { responseCode: 550 }));

    await expect(
      sendPasswordChangedEmail({ email: "ada@example.test", name: "Ada" }),
    ).rejects.toMatchObject({ name: "EmailSendError", kind: "password_changed", statusCode: 550 });
    await expect(
      sendPasswordChangedEmail({ email: "ada@example.test", name: "Ada" }),
    ).rejects.toBeInstanceOf(EmailSendError);
  });
});

describe("the reset link in a suppressed-send log", () => {
  const resetUrl = `https://lombakita.test/auth/reset-password?token=${"t".repeat(64)}`;

  const requestResetFor = async () => {
    mocks.resolveEmailDelivery.mockReturnValue(null);
    await sendPasswordResetEmail({
      email: "ada@example.test",
      name: "Ada",
      rawToken: "t".repeat(64),
    });
    return mocks.resolveEmailDelivery.mock.calls[0]![0] as Record<string, unknown>;
  };

  it("hands the delivery boundary the reset URL on a local machine", async () => {
    mocks.serverEnv.appEnv = "local";

    const context = await requestResetFor();

    expect(context.actionUrl).toBe(resetUrl);
  });

  // Every appEnv except "local", so an environment added to the allow-list by mistake is caught.
  it.each(["test", "preview", "staging", "production"])(
    "hands it no URL when appEnv is %s",
    async (appEnv) => {
      mocks.serverEnv.appEnv = appEnv;

      const context = await requestResetFor();

      expect(context.actionUrl).toBeUndefined();
      expect(JSON.stringify(context)).not.toContain("t".repeat(64));
    },
  );
});
