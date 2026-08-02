// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const loadDelivery = async (overrides: {
  resendApiKey?: string;
  authEmailFrom?: string;
  emailDeliveryEnabled?: boolean;
  appEnv?: string;
}) => {
  vi.resetModules();

  vi.doMock("@/config/env.server", () => ({
    serverEnv: {
      resendApiKey: "resend_key",
      authEmailFrom: "auth@lombakita.com",
      emailDeliveryEnabled: true,
      appEnv: "production",
      ...overrides,
    },
  }));

  return import("@/server/email/delivery");
};

afterEach(() => {
  vi.doUnmock("@/config/env.server");
  vi.resetModules();
});

describe("resolveEmailDelivery", () => {
  it("returns the credentials when delivery is enabled", async () => {
    const { resolveEmailDelivery } = await loadDelivery({});

    expect(resolveEmailDelivery({ kind: "registration_verification", to: "a@b.com" })).toEqual({
      apiKey: "resend_key",
      from: "auth@lombakita.com",
    });
  });

  // The two failures are deliberately different: a missing provider is a misconfiguration the
  // operator must hear about, while a suppressed send is the expected local behaviour.
  it("throws when the provider is not configured", async () => {
    const { resolveEmailDelivery } = await loadDelivery({ resendApiKey: undefined });

    expect(() =>
      resolveEmailDelivery({ kind: "registration_verification", to: "a@b.com" }),
    ).toThrow(/not fully configured/);
  });

  it("throws when the sender address is not configured", async () => {
    const { resolveEmailDelivery } = await loadDelivery({ authEmailFrom: undefined });

    expect(() =>
      resolveEmailDelivery({ kind: "registration_verification", to: "a@b.com" }),
    ).toThrow(/not fully configured/);
  });

  it("returns null without throwing when delivery is disabled", async () => {
    const { resolveEmailDelivery } = await loadDelivery({
      emailDeliveryEnabled: false,
      appEnv: "local",
    });

    expect(resolveEmailDelivery({ kind: "registration_verification", to: "a@b.com" })).toBeNull();
  });

  // A configured-but-suppressed send must still report enough to act on, or local signup has no
  // way to reach the verification link.
  it("logs the action URL when suppressing", async () => {
    const infoSpy = vi.fn();
    vi.resetModules();
    vi.doMock("@/config/env.server", () => ({
      serverEnv: {
        resendApiKey: "resend_key",
        authEmailFrom: "auth@lombakita.com",
        emailDeliveryEnabled: false,
        appEnv: "local",
      },
    }));
    vi.doMock("@/lib/logger", () => ({ logger: { info: infoSpy, warn: vi.fn(), error: vi.fn() } }));

    const { resolveEmailDelivery } = await import("@/server/email/delivery");

    resolveEmailDelivery({
      kind: "registration_verification",
      to: "a@b.com",
      actionUrl: "https://lombakita.test/auth/verify-email?token=abc",
    });

    expect(infoSpy).toHaveBeenCalledWith("email.delivery_suppressed", {
      kind: "registration_verification",
      to: "a@b.com",
      appEnv: "local",
      actionUrl: "https://lombakita.test/auth/verify-email?token=abc",
    });

    vi.doUnmock("@/lib/logger");
  });

  it("omits the action URL from the log when none is supplied", async () => {
    const infoSpy = vi.fn();
    vi.resetModules();
    vi.doMock("@/config/env.server", () => ({
      serverEnv: {
        resendApiKey: "resend_key",
        authEmailFrom: "auth@lombakita.com",
        emailDeliveryEnabled: false,
        appEnv: "local",
      },
    }));
    vi.doMock("@/lib/logger", () => ({ logger: { info: infoSpy, warn: vi.fn(), error: vi.fn() } }));

    const { resolveEmailDelivery } = await import("@/server/email/delivery");

    resolveEmailDelivery({ kind: "registration_confirmed", to: "a@b.com" });

    expect(infoSpy).toHaveBeenCalledWith("email.delivery_suppressed", {
      kind: "registration_confirmed",
      to: "a@b.com",
      appEnv: "local",
    });

    vi.doUnmock("@/lib/logger");
  });
});
