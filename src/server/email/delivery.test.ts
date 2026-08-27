// @vitest-environment node

// WHERE THE REFUSAL SITS RELATIVE TO THE DELIVERY FLAG.
//
// Three outcomes, and the middle one is the whole reason the guard moved. A reserved address is
// refused when a send was about to happen and SUPPRESSED when one was not, because refusing in a
// process that would never have sent adds no safety and breaks every local flow that used to
// complete from the console.

import { afterEach, describe, expect, it, vi } from "vitest";

const RESERVED = "fixture-01@seed.lombakita.local";
const ROUTABLE = "candidate@gmail.com";

const loadDeliveryWith = async (overrides: Record<string, unknown>) => {
  vi.resetModules();
  vi.doMock("@/config/env.server", () => ({
    serverEnv: {
      resendApiKey: "re_test_key_not_real_0000000000",
      authEmailFrom: "noreply@lombakita.com",
      emailDeliveryEnabled: true,
      appEnv: "production",
      ...overrides,
    },
  }));
  return import("./delivery");
};

afterEach(() => {
  vi.doUnmock("@/config/env.server");
  vi.resetModules();
});

describe("resolveEmailDelivery", () => {
  it("refuses a reserved recipient when delivery is ON", async () => {
    const { resolveEmailDelivery } = await loadDeliveryWith({ emailDeliveryEnabled: true });

    // Asserted on the refusal's own fields rather than with `instanceof`. `vi.resetModules()` hands
    // the module under test a FRESH copy of reserved-recipients, so the class thrown is not the
    // class this file could import — an identity check there fails while the guard works, which is
    // a test reporting on the module registry rather than on the behaviour.
    expect(() => resolveEmailDelivery({ kind: "registration_confirmed", to: RESERVED })).toThrow(
      /reserved TLD "\.local"/,
    );

    try {
      resolveEmailDelivery({ kind: "registration_confirmed", to: RESERVED });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).name).toBe("ReservedRecipientError");
      expect((error as { tld: string }).tld).toBe("local");
      expect((error as { kind: string }).kind).toBe("registration_confirmed");
    }
  });

  it("SUPPRESSES a reserved recipient when delivery is OFF, rather than throwing", async () => {
    // The restored local-development behaviour. Before the guard moved, this threw, and sixteen of
    // the seventeen flows that hit it failed invisibly — three fire-and-forget in process, thirteen
    // inside a worker whose inbox row had already been written.
    const { resolveEmailDelivery } = await loadDeliveryWith({
      emailDeliveryEnabled: false,
      appEnv: "local",
    });

    expect(resolveEmailDelivery({ kind: "registration_verification", to: RESERVED })).toBeNull();
  });

  it("returns the credential for a routable recipient when delivery is ON", async () => {
    const { resolveEmailDelivery } = await loadDeliveryWith({ emailDeliveryEnabled: true });

    expect(resolveEmailDelivery({ kind: "registration_confirmed", to: ROUTABLE })).toEqual({
      apiKey: "re_test_key_not_real_0000000000",
      from: "noreply@lombakita.com",
    });
  });

  it("suppresses a routable recipient when delivery is OFF", async () => {
    const { resolveEmailDelivery } = await loadDeliveryWith({
      emailDeliveryEnabled: false,
      appEnv: "local",
    });

    expect(resolveEmailDelivery({ kind: "registration_confirmed", to: ROUTABLE })).toBeNull();
  });

  it("still refuses an unconfigured provider before anything else", async () => {
    const { resolveEmailDelivery } = await loadDeliveryWith({ resendApiKey: undefined });

    expect(() => resolveEmailDelivery({ kind: "registration_confirmed", to: ROUTABLE })).toThrow(
      /not fully configured/,
    );
  });
});
