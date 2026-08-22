// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildServerEnv } from "@/config/env.server";

const baseEnv = (overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  RESEND_API_KEY: "resend_key",
  AUTH_EMAIL_FROM: "auth@lombakita.com",
  ...overrides,
});

describe("emailDeliveryEnabled", () => {
  it("is off by default in local", () => {
    expect(buildServerEnv(baseEnv({ APP_ENV: "local" })).emailDeliveryEnabled).toBe(false);
  });

  it("is on in local only with an explicit opt-in", () => {
    const env = baseEnv({ APP_ENV: "local", EMAIL_DELIVERY_ENABLED: "true" });

    expect(buildServerEnv(env).emailDeliveryEnabled).toBe(true);
  });

  // `test` is where the seeded matrix runs, and every seeded address is a non-routable
  // `@seed.lombakita.local`. Delivering there is a hard bounce against the sending domain, so the
  // answer is no — and unlike local, no flag can say otherwise.
  it("is off in test", () => {
    expect(buildServerEnv(baseEnv({ APP_ENV: "test" })).emailDeliveryEnabled).toBe(false);
  });

  it("stays off in test even with the opt-in flag set", () => {
    const env = baseEnv({ APP_ENV: "test", EMAIL_DELIVERY_ENABLED: "true" });

    expect(buildServerEnv(env).emailDeliveryEnabled).toBe(false);
  });

  // Deployed environments must never depend on the flag being remembered.
  it.each(["preview", "staging", "production"])("is on in %s without the flag", (appEnv) => {
    expect(buildServerEnv(baseEnv({ APP_ENV: appEnv })).emailDeliveryEnabled).toBe(true);
  });

  it("ignores the flag outside local", () => {
    const env = baseEnv({ APP_ENV: "production", EMAIL_DELIVERY_ENABLED: "false" });

    expect(buildServerEnv(env).emailDeliveryEnabled).toBe(true);
  });

  // The key stays readable — the gate governs whether we send, never whether we are configured.
  it("does not hide a configured key when delivery is suppressed", () => {
    const env = baseEnv({ APP_ENV: "local" });
    const built = buildServerEnv(env);

    expect(built.emailDeliveryEnabled).toBe(false);
    expect(built.resendApiKey).toBe("resend_key");
  });
});
