import type { Breadcrumb, Event } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

import { scrubSentryBreadcrumb, scrubSentryEvent } from "./scrub-sentry-event";

const allowedHeaders = {
  "User-Agent": "test-agent",
  "ACCEPT-LANGUAGE": "id",
  "Content-Type": "application/json",
  Host: "example.test",
  "X-Vercel-Id": "test-request-id",
};

describe("scrubSentryEvent", () => {
  it("redacts every real Drizzle query exception without mutating the event", () => {
    const email = "drizzle-sentinel@example.invalid";
    const error = new DrizzleQueryError(
      "select $1",
      [email, "\nparams: repeated-value"],
      new Error("query failed"),
    );
    const event: Event = {
      exception: {
        values: [
          { type: "Error", value: error.message },
          { type: "Error", value: "ordinary error\nparams: preserved" },
          { type: "Error", value: "wrapped: Failed query: select 1\nparams: keep-me" },
          { type: "Error", value: error.message },
          { type: "Error", value: "Failed query: select 1" },
          { type: "Error" },
        ],
      },
    };
    const original = structuredClone(event);
    const result = scrubSentryEvent(event);
    for (const exception of result.exception!.values!) {
      expect(exception.value ?? "").not.toContain(email);
    }
    expect(result.exception!.values!.map(({ value }) => value)).toEqual([
      "Failed query: select $1\nparams: [redacted]",
      "[redacted: database error]",
      "wrapped: Failed query: select 1\nparams: [redacted]",
      "Failed query: select $1\nparams: [redacted]",
      "Failed query: select 1",
      "[redacted: database error]",
    ]);
    expect(event).toEqual(original);
  });

  it("preserves every exception field except the redacted database values", () => {
    const fields = {
      type: "DatabaseError",
      mechanism: { type: "chained", handled: true },
      stacktrace: { frames: [{ filename: "query.ts", function: "load", lineno: 42 }] },
    };
    const event: Event = {
      exception: {
        values: [
          { ...fields, value: 'invalid input syntax for type uuid: "driver-sentinel"' },
          { ...fields, value: "Failed query: select $1\nparams: params-sentinel" },
          { ...fields, value: "load failed: Failed query: select $1\nparams: wrapped-sentinel" },
        ],
      },
    };
    const original = structuredClone(event);
    const result = scrubSentryEvent(event);
    for (const [index, exception] of result.exception!.values!.entries()) {
      const originalFields = Object.entries(original.exception!.values![index]!).filter(
        ([key]) => key !== "value",
      );
      const remainingFields = Object.entries(exception).filter(([key]) => key !== "value");
      expect(remainingFields).toStrictEqual(originalFields);
    }
    expect(result.exception!.values!.map(({ value }) => value)).toStrictEqual([
      "[redacted: database error]",
      "Failed query: select $1\nparams: [redacted]",
      "load failed: Failed query: select $1\nparams: [redacted]",
    ]);
    expect(event).toStrictEqual(original);
  });

  it("leaves a non-Drizzle exception chain and the colonless keyword untouched", () => {
    const event: Event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "Failed query select $1\nparams: preserved",
            mechanism: { type: "generic", handled: false },
            stacktrace: { frames: [{ filename: "load.ts", lineno: 7 }] },
          },
          { type: "TypeError", value: "ordinary failure", mechanism: { type: "generic" } },
        ],
      },
    };
    const original = structuredClone(event);
    expect(scrubSentryEvent(event)).toStrictEqual(original);
    expect(event).toStrictEqual(original);
  });

  it("cuts the first params line after the colon-bearing query keyword", () => {
    const value =
      "load failed\nparams: prefix\nFailed query: select $1\nparams: first\nparams: second";
    const result = scrubSentryEvent({ exception: { values: [{ type: "Error", value }] } });
    expect(result.exception.values[0]!.value).toBe(
      "load failed\nparams: prefix\nFailed query: select $1\nparams: [redacted]",
    );
  });

  it("drops console breadcrumbs while scrubbing fetch and navigation data", () => {
    const event: Event = {
      breadcrumbs: [
        { category: "console", message: "console-sentinel@example.invalid" },
        {
          category: "fetch",
          data: {
            url: "/fetch?token=fetch-sentinel",
            "http.query": "query-sentinel",
            "http.fragment": "fragment-sentinel",
            status_code: 200,
          },
        },
        { category: "navigation", data: { to: "/verify?token=navigation-sentinel" } },
      ],
    };
    const original = structuredClone(event);
    expect(scrubSentryEvent(event).breadcrumbs).toStrictEqual([
      { category: "fetch", data: { url: "/fetch", status_code: 200 } },
      { category: "navigation", data: { to: "/verify" } },
    ]);
    expect(event).toEqual(original);
  });

  it("deletes request.env without mutating the request", () => {
    const event: Event = { request: { env: { REMOTE_ADDR: "env-sentinel" }, method: "GET" } };
    const original = structuredClone(event);
    expect(scrubSentryEvent(event).request).toStrictEqual({ method: "GET" });
    expect(event).toEqual(original);
  });

  it.each([
    "cookie",
    "authorization",
    "set-cookie",
    "referer",
    "origin",
    "x-csrf-token",
    "x-forwarded-for",
    "x-custom",
  ])("removes denied header %s with exactly the supplied allowed keys", (deniedHeader) => {
    const suppliedAllowedHeaders = { "User-Agent": "test-agent", Host: "example.test" };
    const result = scrubSentryEvent({
      request: { headers: { ...suppliedAllowedHeaders, [deniedHeader]: "denied-sentinel" } },
    });
    expect(result.request.headers).not.toHaveProperty(deniedHeader);
    expect(Object.keys(result.request.headers!)).toEqual(Object.keys(suppliedAllowedHeaders));
    expect(result.request.headers).toEqual(suppliedAllowedHeaders);
  });

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
  it("drops console breadcrumbs even without data", () => {
    expect(
      scrubSentryBreadcrumb({ category: "console", message: "email-sentinel@example.invalid" }),
    ).toBeNull();
    expect(
      scrubSentryBreadcrumb({
        category: "console",
        data: { arguments: ["email-sentinel@example.invalid"] },
      }),
    ).toBeNull();
  });

  it("deletes separate HTTP query and fragment data", () => {
    expect(
      scrubSentryBreadcrumb({
        category: "fetch",
        data: {
          "http.query": "query-sentinel",
          "http.fragment": "fragment-sentinel",
          url: "/fetch",
        },
      }),
    ).toStrictEqual({ category: "fetch", data: { url: "/fetch" } });
  });

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
