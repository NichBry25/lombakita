import type { Breadcrumb, Event } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";

import { scrubSentryBreadcrumb, scrubSentryEvent } from "./scrub-sentry-event";

const allowedHeaders = {
  "User-Agent": "test-agent",
  "ACCEPT-LANGUAGE": "id",
  "Content-Type": "application/json",
  Host: "example.test",
  "X-Vercel-Id": "test-request-id",
};

describe("scrubSentryEvent", () => {
  it("removes personal request data while keeping only the five allowed headers", () => {
    const event: Event = {
      message: "render failure",
      request: {
        method: "POST",
        headers: {
          ...allowedHeaders,
          Cookie: "cookie-sentinel",
          AUTHORIZATION: "authorization-sentinel",
          "x-forwarded-for": "header-ip-sentinel",
          "x-custom": "custom-sentinel",
        },
        cookies: { session: "session-sentinel" },
        data: { email: "body-sentinel" },
        query_string: "token=query-sentinel",
        url: "/auth/verify-email?token=url-sentinel#fragment-sentinel",
      },
      user: { ip_address: "ip-sentinel", email: "user-sentinel" },
      contexts: {
        nextjs: { request_path: "/auth/verify-email?token=context-sentinel", router: "App Router" },
        runtime: { name: "node" },
      },
      breadcrumbs: [
        {
          data: {
            url: "/verify?token=breadcrumb-sentinel",
            from: "/from#fragment-sentinel",
            to: "/to?token=breadcrumb-sentinel",
            status_code: 200,
          },
        },
      ],
    };
    const original = structuredClone(event);
    const result = scrubSentryEvent(event);
    expect(result.request?.headers).toEqual(allowedHeaders);
    expect(result.request).not.toHaveProperty("cookies");
    expect(result.request).not.toHaveProperty("data");
    expect(result.request).not.toHaveProperty("query_string");
    expect(result).not.toHaveProperty("user");
    expect(result.request?.url).toBe("/auth/verify-email");
    expect(result.contexts?.nextjs).toEqual({
      request_path: "/auth/verify-email",
      router: "App Router",
    });
    expect(result.breadcrumbs?.[0]?.data).toEqual({
      url: "/verify",
      from: "/from",
      to: "/to",
      status_code: 200,
    });
    expect(JSON.stringify(result)).not.toContain("sentinel");
    expect(result.message).toBe(event.message);
    expect(result.request?.method).toBe("POST");
    expect(result.contexts?.runtime).toEqual({ name: "node" });
    expect(event).toEqual(original);
  });

  it.each(["/path?query#fragment", "/path#fragment?query", "/path?", "/path#", "/path"])(
    "strips from the first delimiter in %s",
    (url) => {
      const result = scrubSentryEvent({
        request: { url },
        contexts: { nextjs: { request_path: url } },
      });
      expect(result.request?.url).toBe("/path");
      expect(result.contexts?.nextjs?.request_path).toBe("/path");
    },
  );

  it("accepts an event with no optional request fields", () => {
    expect(scrubSentryEvent({})).toEqual({});
    expect(
      scrubSentryEvent({
        request: { method: "GET" },
        contexts: { nextjs: { router: "App Router" } },
      }),
    ).toEqual({ request: { method: "GET" }, contexts: { nextjs: { router: "App Router" } } });
  });
});

describe("scrubSentryBreadcrumb", () => {
  it("strips URL data without mutating the breadcrumb", () => {
    const breadcrumb: Breadcrumb = {
      category: "navigation",
      data: {
        url: "/url?token=url-sentinel",
        from: "/from#fragment-sentinel?token=url-sentinel",
        to: "/to?token=url-sentinel",
        status_code: 200,
      },
    };
    const original = structuredClone(breadcrumb);
    expect(scrubSentryBreadcrumb(breadcrumb)).toEqual({
      category: "navigation",
      data: { url: "/url", from: "/from", to: "/to", status_code: 200 },
    });
    expect(breadcrumb).toEqual(original);
  });

  it("preserves missing data and non-string values", () => {
    expect(scrubSentryBreadcrumb({ message: "unchanged" })).toEqual({ message: "unchanged" });
    expect(scrubSentryBreadcrumb({ data: { url: null, from: 1, to: undefined } })).toEqual({
      data: { url: null, from: 1, to: undefined },
    });
  });
});
