/**
 * Which pages a search engine is invited to index, declared once.
 *
 * Three mechanisms have to answer the same question and they answer it in different directions:
 * the sitemap lists what to fetch, robots.txt lists what to leave alone, and the `noindex`
 * directive is what actually removes a page from an index. Declared separately they drift, and the
 * gap is silent — a route missing from the sitemap but not disallowed is still perfectly
 * indexable, and neither file is wrong on its own. Both `app/robots.ts` and `app/sitemap.ts` read
 * this module, and `indexable-routes.test.ts` proves they cannot disagree.
 *
 * INDEXING IS OPT-IN. The root layout marks the entire app `noindex`, and only the pages listed
 * here override it. A surface added later is therefore withheld until someone deliberately opens
 * it, rather than exposed until someone notices — which is the failure mode that matters, because
 * nobody audits an index for pages that should not be in it.
 *
 * robots.txt cannot express every exclusion. `/[username]` is a root-level dynamic segment, so
 * `/budi` and `/kontak` are indistinguishable as paths and no prefix rule can separate them. That
 * is the second reason the `noindex` default carries the enforcement and robots.txt only carries
 * the crawl hint.
 */
import type { Metadata } from "next";

/** Pages whose URL is fixed. Dynamic families are enumerated from the database in the sitemap. */
export const STATIC_INDEXABLE_PATHS = [
  "/",
  "/competitions",
  "/kontak",
  "/syarat-ketentuan",
  "/kebijakan-privasi",
] as const;

/**
 * Crawl hints for paths that can be named by prefix.
 *
 * Deliberately NOT a list of everything that is `noindex`. A page that is disallowed here is never
 * fetched, so a crawler never reads its `noindex` — the two directives do different jobs, and
 * naming a page in both is only correct for surfaces that must never be indexed at all. Everything
 * here is an auth, diagnostic, or role-gated surface that has no business in a search result.
 */
export const DISALLOWED_PATH_PREFIXES = [
  "/api/",
  "/auth/",
  "/admin",
  "/candidate-dashboard",
  "/recruiter-dashboard",
  "/finance",
  "/inbox",
  "/saved",
  "/profile",
  "/protected",
  "/dev/",
  "/suspended",
  // The registration form under a competition. The competition itself stays indexable.
  "/competitions/*/*/registration",
  // Institution management. `/institution/<slug>` is the organizer's public page and stays
  // indexable; everything below it is the workspace behind a recruiter session.
  "/institution/create",
  "/institution/personal",
  "/institution/*/team",
  "/institution/*/settings",
  "/institution/*/verification",
  "/institution/*/fees",
  "/institution/*/audit-log",
  "/institution/*/competitions",
] as const;

/** Applied by every page in the indexable set, overriding the root layout's withholding default. */
export const INDEXABLE_ROBOTS: Metadata["robots"] = { index: true, follow: true };

/** The root layout's default, so a page that declares nothing is withheld rather than exposed. */
export const NON_INDEXABLE_ROBOTS: Metadata["robots"] = { index: false, follow: false };

/**
 * Whether a robots.txt disallow rule would stop a crawler fetching `path`.
 *
 * `*` matches any run of characters within a single path segment, which is how the rules above use
 * it — `/institution/*​/team` names one slug, never a deeper tree. Every other rule is a plain
 * prefix, matching robots.txt's own semantics.
 */
export const isPathDisallowed = (path: string): boolean =>
  DISALLOWED_PATH_PREFIXES.some((rule) => {
    if (!rule.includes("*")) return path.startsWith(rule);

    const pattern = rule
      .split("*")
      .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");

    return new RegExp(`^${pattern}`).test(path);
  });
