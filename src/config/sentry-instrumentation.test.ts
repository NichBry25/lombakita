// @vitest-environment node

import type { Breadcrumb, Event } from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureRequestError: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
}));

vi.mock("@sentry/nextjs", () => sentry);

type TransactionEvent = Event & { type: "transaction" };

type InitOptions = {
  dsn?: string;
  tracesSampleRate?: number;
  sendDefaultPii?: boolean;
  integrations?: { name: string }[];
  beforeSend?: (event: Event) => Event;
  beforeSendTransaction?: (event: TransactionEvent) => TransactionEvent;
  beforeBreadcrumb?: (breadcrumb: Breadcrumb) => Breadcrumb;
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("SENTRY_DSN", "sentry-test-dsn");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "browser-test-dsn");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../sentry.server.config");
  vi.doUnmock("../sentry.edge.config");
});

const configurations = [
  { runtime: "browser", load: () => import("../instrumentation-client"), dsn: "browser-test-dsn" },
  { runtime: "server", load: () => import("../sentry.server.config"), dsn: "sentry-test-dsn" },
  { runtime: "edge", load: () => import("../sentry.edge.config"), dsn: "sentry-test-dsn" },
];

describe("Sentry config wiring", () => {
  it.each(configurations)(
    "initializes $runtime once with private error-only reporting",
    async ({ load, dsn }) => {
      await load();
      expect(sentry.init).toHaveBeenCalledTimes(1);
      const options: InitOptions = sentry.init.mock.calls[0]![0];
      expect(options.dsn).toBe(dsn);
      expect(options.tracesSampleRate).toBe(0);
      expect(options.sendDefaultPii).not.toBe(true);
      expect(options.integrations ?? []).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: expect.stringMatching(/replay/i) }),
        ]),
      );
      expect(sentry.replayIntegration).not.toHaveBeenCalled();
      expect(options.beforeSend).toBeTypeOf("function");
      const result = options.beforeSend!({
        request: {
          cookies: { session: "cookie-sentinel" },
          headers: { Cookie: "cookie-sentinel", Authorization: "authorization-sentinel" },
          url: "/auth/verify-email?token=url-sentinel",
        },
        user: { ip_address: "ip-sentinel" },
      });
      expect(result.request).not.toHaveProperty("cookies");
      expect(result.request?.headers).toEqual({});
      expect(result.request?.url).toBe("/auth/verify-email");
      expect(result).not.toHaveProperty("user");
    },
  );

  it.each(configurations.filter(({ runtime }) => runtime !== "browser"))(
    "scrubs $runtime transactions",
    async ({ load }) => {
      await load();
      const options: InitOptions = sentry.init.mock.calls[0]![0];
      expect(options.beforeSendTransaction).toBeTypeOf("function");
      const result = options.beforeSendTransaction!({
        type: "transaction",
        request: {
          cookies: { session: "cookie-sentinel" },
          url: "/auth/verify-email?token=url-sentinel",
        },
      });
      expect(result.type).toBe("transaction");
      expect(result.request).not.toHaveProperty("cookies");
      expect(result.request?.url).toBe("/auth/verify-email");
    },
  );

  it("scrubs browser breadcrumbs through the installed callback", async () => {
    await import("../instrumentation-client");
    const options: InitOptions = sentry.init.mock.calls[0]![0];
    expect(options.beforeBreadcrumb).toBeTypeOf("function");
    const result = options.beforeBreadcrumb!({
      data: {
        url: "/verify?token=url-sentinel",
        from: "/from#fragment-sentinel",
        to: "/to?token=url-sentinel",
      },
    });
    expect(result.data).toEqual({ url: "/verify", from: "/from", to: "/to" });
  });
});

describe("Next.js instrumentation runtime selection", () => {
  it.each(["nodejs", "edge"])("loads only the %s config", async (runtime) => {
    const serverLoaded = vi.fn();
    const edgeLoaded = vi.fn();
    vi.doMock("../sentry.server.config", () => {
      serverLoaded();
      return {};
    });
    vi.doMock("../sentry.edge.config", () => {
      edgeLoaded();
      return {};
    });
    vi.stubEnv("NEXT_RUNTIME", runtime);
    const instrumentation = await import("../instrumentation");
    expect(serverLoaded).not.toHaveBeenCalled();
    expect(edgeLoaded).not.toHaveBeenCalled();
    await instrumentation.register();
    expect(serverLoaded).toHaveBeenCalledTimes(runtime === "nodejs" ? 1 : 0);
    expect(edgeLoaded).toHaveBeenCalledTimes(runtime === "edge" ? 1 : 0);
    expect(instrumentation.onRequestError).toBeTypeOf("function");
  });
});
