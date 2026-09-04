// @vitest-environment node
//
// robots.txt and the sitemap, and the property that matters more than either: that they agree.
//
// A route missing from the sitemap but not disallowed is still indexable, and a route in the
// sitemap that robots.txt disallows is a crawler being invited to a door it has been told not to
// open. Neither file is wrong on its own in either case, which is why the agreement is asserted
// here rather than left to a reading of the two.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPathDisallowed } from "@/config/indexable-routes";

const listSitemapCompetitions = vi.fn();
const listSitemapInstitutions = vi.fn();

vi.mock("@/server/competitions/competition-public-service", () => ({
  listSitemapCompetitions: () => listSitemapCompetitions(),
}));

vi.mock("@/server/institution-workspace/institution-public-service", () => ({
  listSitemapInstitutions: () => listSitemapInstitutions(),
}));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

const UPDATED_AT = new Date("2026-09-01T00:00:00.000Z");

beforeEach(() => {
  listSitemapCompetitions.mockResolvedValue([
    { institutionSlug: "seed-academy", slug: "seed-open", updatedAt: UPDATED_AT },
  ]);
  listSitemapInstitutions.mockResolvedValue([{ slug: "seed-academy", updatedAt: UPDATED_AT }]);
});

/** The path part of an absolute sitemap URL, which is what the disallow rules are written against. */
const pathOf = (url: string): string => new URL(url).pathname;

describe("robots.txt", () => {
  it("points a crawler at the sitemap with an absolute URL", () => {
    const { sitemap: sitemapUrl } = robots();

    expect(typeof sitemapUrl).toBe("string");
    expect(sitemapUrl as string).toMatch(/^https?:\/\/.+\/sitemap\.xml$/);
  });

  it("allows the site root, so the indexable pages are reachable", () => {
    const rules = robots().rules;

    expect(Array.isArray(rules)).toBe(false);
    expect((rules as { allow?: string | string[] }).allow).toBe("/");
  });

  it("disallows the auth, diagnostic and role-gated surfaces", () => {
    const disallow = (robots().rules as { disallow?: string[] }).disallow ?? [];

    for (const expected of ["/auth/", "/protected", "/dev/", "/admin", "/api/"]) {
      expect(disallow).toContain(expected);
    }
  });
});

describe("sitemap.xml", () => {
  it("lists the static public pages", async () => {
    const paths = (await sitemap()).map((entry) => pathOf(entry.url));

    expect(paths).toEqual(
      expect.arrayContaining([
        "/",
        "/competitions",
        "/kontak",
        "/syarat-ketentuan",
        "/kebijakan-privasi",
      ]),
    );
  });

  it("lists a competition detail page under its organizer's slug", async () => {
    const paths = (await sitemap()).map((entry) => pathOf(entry.url));

    expect(paths).toContain("/competitions/seed-academy/seed-open");
  });

  it("lists an organizer's public page", async () => {
    const paths = (await sitemap()).map((entry) => pathOf(entry.url));

    expect(paths).toContain("/institution/seed-academy");
  });

  it("emits absolute URLs, since a sitemap of relative paths is not a sitemap", async () => {
    for (const entry of await sitemap()) {
      expect(entry.url).toMatch(/^https?:\/\//);
    }
  });

  it("advertises nothing beyond what the database and the static set hand it", async () => {
    // Three fixtures in, eight entries out: the five static pages plus one of each dynamic family.
    // A sitemap that invented an entry — a hardcoded auth page, a leftover diagnostic route —
    // would change this count.
    expect(await sitemap()).toHaveLength(7);
  });

  it("carries the entity's own last-modified date, not the time the file was built", async () => {
    const entries = await sitemap();
    const competition = entries.find(
      (entry) => pathOf(entry.url) === "/competitions/seed-academy/seed-open",
    );

    expect(competition?.lastModified).toEqual(UPDATED_AT);
  });

  it("emits nothing when the database has no published content but the static pages remain", async () => {
    listSitemapCompetitions.mockResolvedValue([]);
    listSitemapInstitutions.mockResolvedValue([]);

    expect(await sitemap()).toHaveLength(5);
  });
});

describe("robots.txt and the sitemap agree", () => {
  it("never advertises a URL that robots.txt disallows", async () => {
    for (const entry of await sitemap()) {
      const path = pathOf(entry.url);
      expect(isPathDisallowed(path), `${path} is in the sitemap and disallowed by robots.txt`).toBe(
        false,
      );
    }
  });

  it("advertises no auth, diagnostic, profile or gated route", async () => {
    const paths = (await sitemap()).map((entry) => pathOf(entry.url));

    for (const forbidden of [
      "/auth",
      "/protected",
      "/suspended",
      "/dev",
      "/admin",
      "/candidate-dashboard",
      "/recruiter-dashboard",
      "/finance",
      "/inbox",
      "/saved",
      "/profile",
      "/api",
    ]) {
      expect(paths.some((path) => path.startsWith(forbidden))).toBe(false);
    }
  });

  it("advertises no public profile page, which DEC-0196 withholds from search", async () => {
    // `/[username]` is a root-level dynamic segment, so a profile URL is a single path segment and
    // cannot be told apart from `/kontak` by any prefix rule. The only defence is that nothing
    // puts one in the sitemap, which is what this asserts.
    const paths = (await sitemap()).map((entry) => pathOf(entry.url));
    const knownStatic = [
      "/",
      "/competitions",
      "/kontak",
      "/syarat-ketentuan",
      "/kebijakan-privasi",
    ];

    for (const path of paths) {
      const isSingleSegment = path.split("/").filter(Boolean).length === 1;
      if (isSingleSegment) {
        expect(knownStatic, `${path} looks like a profile URL`).toContain(path);
      }
    }
  });
});
