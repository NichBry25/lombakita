import { serverEnv } from "@/config/env.server";

/**
 * Hostnames that are only ever this machine, and never a site a crawler can reach.
 *
 * `[::1]` is listed alongside `::1` because `new URL(...).hostname` returns an IPv6 literal WITH
 * its brackets. Matching only the bare form never fires — and here that fails OPEN, publishing the
 * loopback origin this exists to refuse. `scripts/lib/local-database-host.ts` solved the same trap
 * first, for connection strings; that module is scripts-only and its question is different ("may I
 * write to this database"), so the set is restated rather than imported, and `0.0.0.0` is added
 * because a bind-all address is publishable-looking and equally unreachable.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/**
 * The absolute origin this deployment is reachable at, for the places that cannot use a relative
 * path: `metadataBase`, Open Graph URLs, robots.txt's sitemap pointer, and the sitemap's own
 * entries. A sitemap of relative paths is not a sitemap.
 *
 * ONE TERM, not a chain. `serverEnv.appBaseUrl` is already `APP_BASE_URL ?? AUTH_URL ??`
 * (NEXT_PUBLIC_APP_URL / VERCEL_URL / a local default), so the `?? serverEnv.authUrl` this used to
 * carry could never fire: `authUrl` is itself `AUTH_URL ?? appBaseUrl`, and reaching the fallback
 * required `appBaseUrl` to be undefined, which already implies `AUTH_URL` is unset. A term that
 * reads as a fallback and cannot be one is worse than no fallback, because the next reader trusts
 * it. Same for the `publicEnv.appUrl` term that followed it.
 *
 * IT REFUSES RATHER THAN GUESSING IN PRODUCTION. The old form ended in a bare
 * `?? "http://localhost:3000"`, so a production runtime that lost its configuration would not fail
 * — it would serve a robots.txt reading `Sitemap: http://localhost:3000/sitemap.xml` and 46
 * sitemap entries pointing at the crawler's own machine, silently and indefinitely. Nothing
 * downstream can detect that, because every one of those URLs is well-formed. A loopback origin is
 * refused for the same reason: it is not "missing", so no absence check would catch it.
 *
 * Deliberately keyed on `appEnv` rather than `NODE_ENV`: a local `next start` and a preview
 * deployment both run with `NODE_ENV=production`, and neither should be held to the canonical
 * apex — a preview is supposed to describe itself.
 */
export const resolveSiteOrigin = (): string => {
  const configured = serverEnv.appBaseUrl;
  const isProduction = serverEnv.appEnv === "production";

  if (!configured) {
    if (isProduction) {
      throw new Error(
        "No site origin is configured, so every crawler-facing URL this deployment emits would be " +
          "a guess. Set APP_BASE_URL to the canonical origin. Refusing rather than falling back to " +
          "localhost, which would publish a sitemap and a robots.txt nobody could follow and " +
          "nothing would report.",
      );
    }

    return "http://localhost:3000";
  }

  // Trailing slashes make `new URL(path, origin)` and plain concatenation disagree, and the
  // sitemap would emit both shapes for the same page.
  const origin = configured.replace(/\/+$/, "");

  if (isProduction && isLoopbackOrigin(origin)) {
    throw new Error(
      `The configured site origin is ${origin}, which is this machine rather than a reachable ` +
        "site. In production every sitemap entry, canonical URL and Open Graph URL is built from " +
        "it, so publishing it would point an entire launch at localhost.",
    );
  }

  return origin;
};

/** Absolute URL for a site-relative path, for the crawler-facing surfaces above. */
export const absoluteSiteUrl = (path: string): string => `${resolveSiteOrigin()}${path}`;
