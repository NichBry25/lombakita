// @vitest-environment node
//
// The origin every crawler-facing URL is built from.
//
// robots.txt's sitemap pointer, all 46 sitemap entries, `metadataBase`, and therefore every
// canonical and Open Graph URL in the app resolve against this one string. Its old form ended in a
// bare `?? "http://localhost:3000"`, so a production runtime that lost its configuration would not
// fail — it would publish a sitemap pointing at the crawler's own machine, indefinitely, and every
// URL in it would be well-formed. Nothing downstream can detect that, which is why the refusal
// lives here rather than in a check further along.

import { afterEach, describe, expect, it, vi } from "vitest";

const serverEnv = { appBaseUrl: undefined as string | undefined, appEnv: "local" as string };

vi.mock("@/config/env.server", () => ({
  get serverEnv() {
    return serverEnv;
  },
}));

const { resolveSiteOrigin, absoluteSiteUrl } = await import("@/config/site-url");

const configure = (appEnv: string, appBaseUrl: string | undefined) => {
  serverEnv.appEnv = appEnv;
  serverEnv.appBaseUrl = appBaseUrl;
};

afterEach(() => configure("local", undefined));

describe("resolveSiteOrigin", () => {
  it("returns the configured origin", () => {
    configure("production", "https://lombakita.com");

    expect(resolveSiteOrigin()).toBe("https://lombakita.com");
  });

  it("strips a trailing slash, so one page never gets two URL shapes", () => {
    configure("production", "https://lombakita.com/");

    expect(resolveSiteOrigin()).toBe("https://lombakita.com");
  });

  it("refuses to guess in production when nothing is configured", () => {
    configure("production", undefined);

    expect(() => resolveSiteOrigin()).toThrow(/production publishes exactly/);
  });

  // THE VALUE, NOT THE SHAPE, and not only at the CI gate. `env-shape.ts` asserts the same
  // equality, but it runs only in CI — a `vercel` CLI deploy that bypasses the workflow never
  // reaches it. Every one of these was RETURNED before this clause existed, measured.
  it.each([
    ["an unrelated domain", "https://evil.example"],
    ["the deployment host rather than the apex", "https://lombakita.vercel.app"],
    ["the www variant that redirects to the apex", "https://www.lombakita.com"],
    ["the canonical host over plain http", "http://lombakita.com"],
  ])("refuses %s in production", (_label, origin) => {
    configure("production", origin);

    expect(() => resolveSiteOrigin()).toThrow(/production publishes exactly/);
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.0.0.2:3000",
    "http://[::1]:3000",
    "http://[::ffff:127.0.0.1]:3000",
    "http://0.0.0.0:3000",
  ])("refuses %s in production", (origin) => {
    configure("production", origin);

    expect(() => resolveSiteOrigin()).toThrow(/production publishes exactly/);
  });

  // A preview deployment is supposed to describe itself, and a local `next start` runs with
  // NODE_ENV=production — which is exactly why the guard keys on appEnv instead.
  it("allows a per-deployment origin in preview", () => {
    configure("preview", "https://lombakita-abc123.vercel.app");

    expect(resolveSiteOrigin()).toBe("https://lombakita-abc123.vercel.app");
  });

  // Loopback is the whole 127/8 range, and `URL` collapses both spellings of an IPv4-mapped
  // address to `[::ffff:7f00:1]`. A set holding only `127.0.0.1` and `::1` accepts the rest —
  // measured: `http://127.0.0.2:3000` was returned before this widened.
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.0.0.2:3000",
    "http://127.255.255.254:3000",
    "http://[::1]:3000",
    "http://[::ffff:127.0.0.1]:3000",
    "http://0.0.0.0:3000",
  ])("refuses %s in a deployed preview, which must be reachable", (origin) => {
    configure("preview", origin);

    expect(() => resolveSiteOrigin()).toThrow(/this machine rather than a reachable site/);
  });

  it("still falls back to localhost outside production", () => {
    configure("local", undefined);

    expect(resolveSiteOrigin()).toBe("http://localhost:3000");
  });

  it("allows localhost outside production, where it is the correct answer", () => {
    configure("test", "http://localhost:3000");

    expect(resolveSiteOrigin()).toBe("http://localhost:3000");
  });
});

describe("absoluteSiteUrl", () => {
  it("joins a site-relative path onto the resolved origin", () => {
    configure("production", "https://lombakita.com");

    expect(absoluteSiteUrl("/sitemap.xml")).toBe("https://lombakita.com/sitemap.xml");
  });

  it("carries the production refusal, rather than emitting a localhost URL", () => {
    configure("production", "http://localhost:3000");

    expect(() => absoluteSiteUrl("/sitemap.xml")).toThrow();
  });

  it("carries the production refusal for a well-formed wrong domain too", () => {
    configure("production", "https://evil.example");

    expect(() => absoluteSiteUrl("/sitemap.xml")).toThrow();
  });
});
