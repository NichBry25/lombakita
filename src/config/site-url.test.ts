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

    expect(() => resolveSiteOrigin()).toThrow(/No site origin is configured/);
  });

  it("refuses a loopback origin in production", () => {
    // The failure this exists for: not a MISSING value, which any absence check would catch, but a
    // present, well-formed, entirely useless one.
    configure("production", "http://localhost:3000");

    expect(() => resolveSiteOrigin()).toThrow(/this machine rather than a reachable site/);
  });

  it.each(["http://127.0.0.1:3000", "http://[::1]:3000", "http://0.0.0.0:3000"])(
    "refuses %s in production too",
    (origin) => {
      configure("production", origin);

      expect(() => resolveSiteOrigin()).toThrow(/this machine rather than a reachable site/);
    },
  );

  // A preview deployment is supposed to describe itself, and a local `next start` runs with
  // NODE_ENV=production — which is exactly why the guard keys on appEnv instead.
  it("allows a per-deployment origin in preview", () => {
    configure("preview", "https://lombakita-abc123.vercel.app");

    expect(resolveSiteOrigin()).toBe("https://lombakita-abc123.vercel.app");
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
});
