// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DISALLOWED_PATH_PREFIXES,
  INDEXABLE_ROBOTS,
  NON_INDEXABLE_ROBOTS,
  STATIC_INDEXABLE_PATHS,
  isPathDisallowed,
} from "@/config/indexable-routes";
import {
  DYNAMIC_FAMILY_FIXTURES,
  INDEXABLE_SHELL_ROUTES,
} from "../../scripts/testing/indexable-shell-routes.mjs";

// Representative URLs for the two dynamic families that are indexable. The slugs are arbitrary —
// what is asserted is the SHAPE, since no rule may depend on a particular organizer's name.
const INDEXABLE_DYNAMIC_PATHS = [
  "/competitions/seed-academy/seed-open",
  "/institution/seed-academy",
];

// Every surface the block requires to stay out of search, named as the URL a crawler would try.
const MUST_BE_WITHHELD = [
  "/auth/login",
  "/auth/register",
  "/auth/signup",
  "/auth/sign-in",
  "/auth/mfa/challenge",
  "/protected",
  "/suspended",
  "/dev/primitives",
  "/admin",
  "/admin/moderation",
  "/candidate-dashboard",
  "/recruiter-dashboard",
  "/finance/payments",
  "/inbox",
  "/saved",
  "/profile/edit",
  "/api/v1/competitions",
  "/competitions/seed-academy/seed-open/registration",
  "/institution/create",
  "/institution/personal",
  "/institution/seed-academy/team",
  "/institution/seed-academy/settings",
  "/institution/seed-academy/verification",
  "/institution/seed-academy/fees",
  "/institution/seed-academy/audit-log",
  "/institution/seed-academy/competitions",
  "/institution/seed-academy/competitions/some-competition/participants",
];

describe("the indexable route set", () => {
  it("never disallows a page it also invites a crawler to index", () => {
    for (const path of [...STATIC_INDEXABLE_PATHS, ...INDEXABLE_DYNAMIC_PATHS]) {
      expect(isPathDisallowed(path), `${path} is both indexable and disallowed`).toBe(false);
    }
  });

  it("disallows every auth, diagnostic and role-gated surface", () => {
    for (const path of MUST_BE_WITHHELD) {
      expect(isPathDisallowed(path), `${path} is reachable by a crawler`).toBe(true);
    }
  });

  it("withholds a competition's registration form without withholding the competition", () => {
    expect(isPathDisallowed("/competitions/seed-academy/seed-open")).toBe(false);
    expect(isPathDisallowed("/competitions/seed-academy/seed-open/registration")).toBe(true);
  });

  it("withholds an organizer's workspace without withholding their public page", () => {
    expect(isPathDisallowed("/institution/seed-academy")).toBe(false);
    expect(isPathDisallowed("/institution/seed-academy/team")).toBe(true);
  });

  it("keeps `*` inside a single path segment, so one rule cannot swallow a deeper tree", () => {
    // `/institution/*/team` names one slug. Were `*` to cross a `/`, this would match and the
    // organizer's own public page would start disappearing behind management rules.
    expect(isPathDisallowed("/institution/seed-academy")).toBe(false);
    expect(isPathDisallowed("/institution/a/b/team")).toBe(false);
  });

  it("declares indexing as opt-in, so an unlisted surface is withheld by default", () => {
    expect(NON_INDEXABLE_ROBOTS).toMatchObject({ index: false, follow: false });
    expect(INDEXABLE_ROBOTS).toMatchObject({ index: true, follow: true });
  });

  it("lists exactly the seven pages this launch makes discoverable", () => {
    // Pinned rather than counted: adding a page to the indexable set is a decision, and it should
    // fail here so it is made deliberately rather than noticed later in a search result.
    expect([...STATIC_INDEXABLE_PATHS]).toEqual([
      "/",
      "/competitions",
      "/kontak",
      "/syarat-ketentuan",
      "/kebijakan-privasi",
    ]);
  });

  it("names no disallow rule that is empty or relative", () => {
    for (const rule of DISALLOWED_PATH_PREFIXES) {
      expect(rule.startsWith("/"), `${rule} is not rooted`).toBe(true);
    }
  });
});

describe("the shell-content check covers the whole indexable set", () => {
  // Rule 38: an instrument declares its subject as data and refuses what it cannot classify. The
  // shell check fetches concrete URLs, so it cannot derive its own list from a config that names
  // dynamic families — which means the list can fall behind the config, and a page added to the
  // indexable set would ship without ever being measured. Nothing about that would look wrong: the
  // check would still print a green line for every route it knew about.
  const measured = new Set(INDEXABLE_SHELL_ROUTES.map((route) => route.path));

  it("measures every static indexable page", () => {
    for (const path of STATIC_INDEXABLE_PATHS) {
      expect(measured.has(path), `${path} is indexable but the shell check never fetches it`).toBe(
        true,
      );
    }
  });

  it("measures a fixture from each indexable dynamic family", () => {
    for (const [family, fixture] of Object.entries(DYNAMIC_FAMILY_FIXTURES)) {
      expect(measured.has(fixture), `${family} has no fixture in the shell check`).toBe(true);
    }
  });

  it("measures nothing it is not supposed to invite a crawler to", () => {
    for (const path of measured) {
      expect(isPathDisallowed(path), `${path} is measured but disallowed by robots.txt`).toBe(
        false,
      );
    }
  });

  it("gives every measured route a needle and a label", () => {
    for (const route of INDEXABLE_SHELL_ROUTES) {
      expect(route.needle?.length, `${route.path} has no needle`).toBeGreaterThan(0);
      expect(route.label?.length, `${route.path} has no label`).toBeGreaterThan(0);
    }
  });

  it("never takes a needle from the shared page chrome", () => {
    // The footer names the operating company on all seven pages and the header carries the nav, so
    // either would match on a page serving nothing but chrome — which is the exact page this check
    // exists to catch.
    const CHROME_TEXT = ["KARYA TALENTA NUSANTARA", "Lewati ke konten utama", "Jelajahi"];

    for (const route of INDEXABLE_SHELL_ROUTES) {
      for (const chrome of CHROME_TEXT) {
        expect(route.needle, `${route.path}'s needle is chrome, not body`).not.toBe(chrome);
      }
    }
  });
});
