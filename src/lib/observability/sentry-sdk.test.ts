// @vitest-environment node
import * as Sentry from "@sentry/node";
import { captureRequestError } from "@sentry/nextjs";
import { DrizzleQueryError } from "drizzle-orm";
import { expect, it } from "vitest";
import { scrubSentryEvent, scrubSentryBreadcrumb } from "./scrub-sentry-event";

it("scrubs the real captureRequestError transport envelope", async () => {
  const sentinels = {
    console: ["console", "probe", "email"].join("-") + "@example.invalid",
    params: ["params", "probe", "email"].join("-") + "@example.invalid",
    cookie: ["cookie", "probe", "value"].join("-"),
    custom: ["custom", "probe", "value"].join("-"),
    authorization: ["authorization", "probe", "value"].join("-"),
    token: ["token", "probe", "value"].join("-"),
  };
  const request = {
    path: `/verify?token=${sentinels.token}`,
    method: "GET",
    headers: {
      cookie: sentinels.cookie,
      authorization: sentinels.authorization,
      "x-custom": sentinels.custom,
      "user-agent": "privacy-test-agent",
    },
  };
  const envelopes: unknown[] = [];
  const client = Sentry.init({
    dsn: "https://fixture@example.invalid/1",
    environment: "test",
    tracesSampler: () => 0,
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  expect(client).toBeDefined();
  try {
    Sentry.addBreadcrumb({ category: "console", message: sentinels.console });
    const error = new DrizzleQueryError("select $1", [sentinels.params], new Error("query failed"));
    captureRequestError(error, request, {
      routerKind: "App Router",
      routePath: "/verify",
      routeType: "render",
    });
    expect(await Sentry.flush(2000)).toBe(true);
    expect(envelopes.length).toBeGreaterThan(0);
    const payload = JSON.stringify(envelopes);
    expect(payload).toContain("Failed query:");
    expect(payload).toContain("auto.function.nextjs.on_request_error");
    expect(payload).toContain("privacy-test-agent");
    for (const sentinel of Object.values(sentinels)) {
      expect(payload.includes(sentinel), "a personal-data sentinel reached the transport").toBe(
        false,
      );
    }
  } finally {
    await Sentry.close(2000);
    Sentry.getCurrentScope().clear();
    Sentry.getIsolationScope().clear();
  }
});
