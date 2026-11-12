// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { serverEnv } = vi.hoisted(() => ({
  serverEnv: {
    resendApiKey: "re_test_key",
    authEmailFrom: "noreply@seed.lombakita.local",
    authUrl: "https://lombakita.local",
    appBaseUrl: undefined as string | undefined,
    emailDeliveryEnabled: true,
    appEnv: "test",
  },
}));

vi.mock("@/config/env.server", () => ({ serverEnv }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "https://lombakita.local" } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { buildVerificationUrl } from "@/server/auth/email-verification";

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
