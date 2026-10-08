// @vitest-environment node
import * as Sentry from "@sentry/node";
import type { Event } from "@sentry/node";
import type { Envelope } from "@sentry/core";
import { captureRequestError } from "@sentry/nextjs";
import { DrizzleQueryError } from "drizzle-orm";
import { expect, it } from "vitest";
import { scrubSentryEvent, scrubSentryBreadcrumb } from "./scrub-sentry-event";

it.each(["direct", "wrapped"])("scrubs the real %s Drizzle transport envelope", async (kind) => {
  const sentinels = {
    console: ["console", "probe", "email"].join("-") + "@example.invalid",
    params: ["params", "probe", "email"].join("-") + "@example.invalid",
    cookie: ["cookie", "probe", "value"].join("-"),
    custom: ["custom", "probe", "value"].join("-"),
    authorization: ["authorization", "probe", "value"].join("-"),
    token: ["token", "probe", "value"].join("-"),
    driver: ["sentinel", "uuid", "value"].join("-") + "@x.invalid",
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
  const envelopes: Envelope[] = [];
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
    const cause = new Error(`invalid input syntax for type uuid: "${sentinels.driver}"`);
    const drizzleError = new DrizzleQueryError("select $1", [sentinels.params], cause);
    const error =
      kind === "wrapped" ? new Error(`load failed: ${drizzleError.message}`) : drizzleError;
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
    const events: Event[] = [];
    for (const [, items] of envelopes) {
      for (const [header, body] of items) {
        if (header.type === "event") events.push(body as Event);
      }
    }
    const event = events[0]!;
    const drizzleEntry = event.exception!.values!.find(({ value }) =>
      value?.includes("Failed query:"),
    );
    expect(drizzleEntry?.type).toBe("Error");
    expect(drizzleEntry?.stacktrace?.frames?.length).toBeGreaterThan(0);
    if (kind === "direct") {
      expect(event.exception!.values!.length).toBeGreaterThan(1);
      expect(
        event.exception!.values!.some(({ value }) => value === "[redacted: database error]"),
      ).toBe(true);
    }
  } finally {
    await Sentry.close(2000);
    Sentry.getCurrentScope().clear();
    Sentry.getIsolationScope().clear();
  }
});
