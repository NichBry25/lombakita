import { CANONICAL_SITE_ORIGIN } from "@/config/company";
import { serverEnv } from "@/config/env.server";

/**
 * Hostnames and address ranges that are only ever this machine, never a site a crawler can reach.
 *
 * THREE TRAPS, each of which makes the check silently pass something it exists to refuse:
 *
 *   `[::1]` — `new URL(...).hostname` returns an IPv6 literal WITH its brackets, so matching only
 *   the bare `::1` never fires.
 *
 *   `127.0.0.2` — loopback is the whole `127.0.0.0/8` range, not one address. A set holding only
 *   `127.0.0.1` accepts every other one of the sixteen million.
 *
 *   `[::ffff:127.0.0.1]` — an IPv4-mapped IPv6 address, which `URL` normalises to
 *   `[::ffff:7f00:1]`, matching neither the IPv4 nor the IPv6 spelling.
 *
 * `scripts/lib/local-database-host.ts` asks a similar question and carries the same 127/8 gap.
 * DELIBERATELY NOT SHARED. Its predicate gates a refusal — `live-harness.ts:93` throws unless every
 * connection string IS loopback — so widening it would PERMIT writes to `127.0.0.2` that are
 * refused today. Sharing a matcher between a guard that refuses non-loopback and one that refuses
 * loopback means every widening loosens one of them. The two also differ on policy: `0.0.0.0` is
 * publishable-looking and unreachable, so it belongs here, while a database bound to it is a real
 * thing to refuse writing to.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "[::1]", "0.0.0.0"]);

// `URL` lowercases the hostname and collapses IPv4-mapped forms to hex, so both spellings of
// mapped loopback arrive here as `[::ffff:7f00:1]`.
const MAPPED_IPV4_LOOPBACK = /^\[::ffff:7f00:[0-9a-f]{1,4}\]$/;
const IPV4_LOOPBACK_RANGE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const isLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTNAMES.has(hostname) ||
  IPV4_LOOPBACK_RANGE.test(hostname) ||
  MAPPED_IPV4_LOOPBACK.test(hostname);

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
};

// Trailing slashes make `new URL(path, origin)` and plain concatenation disagree, and the sitemap
// would emit both shapes for the same page.
const withoutTrailingSlash = (origin: string): string => origin.replace(/\/+$/, "");

/**
 * The absolute origin this deployment is reachable at, for the places that cannot use a relative
 * path: `metadataBase`, Open Graph URLs, robots.txt's sitemap pointer, and the sitemap's own
 * entries. A sitemap of relative paths is not a sitemap.
 *
 * ONE TERM, not a chain. `serverEnv.appBaseUrl` is already `APP_BASE_URL ?? AUTH_URL ??`
 * (NEXT_PUBLIC_APP_URL / VERCEL_URL / a local default), so the `?? serverEnv.authUrl` this used to
 * carry could never fire: reaching the fallback required `appBaseUrl` to be undefined, which
 * already implies `AUTH_URL` is unset. A term that reads as a fallback and cannot be one is worse
 * than no fallback, because the next reader trusts it.
 *
 * PRODUCTION IS PINNED TO THE CANONICAL ORIGIN, not merely checked for shape. `env-shape.ts`
 * asserts the same equality, but it runs ONLY in CI — a `vercel` CLI deploy that bypasses the
 * workflow never reaches it, and this function would then have accepted `https://evil.example`,
 * `https://lombakita.vercel.app`, `https://www.lombakita.com` or a plain-http origin and built
 * every canonical URL, Open Graph URL and sitemap entry from it. Measured, not assumed: all four
 * were returned before this clause existed. Same constant as the deploy gate, deliberately — a
 * second source for the site's own address is how the two start disagreeing.
 *
 * A DEPLOYED PREVIEW MUST STILL BE REACHABLE. Preview and staging are per-deployment and correct,
 * so they are not held to the apex — but a loopback origin is not a preview URL either, and it is
 * not "missing", so no absence check would catch it. Local development is the one environment
 * where localhost is the right answer.
 *
 * Keyed on `appEnv` rather than `NODE_ENV`: a local `next start` and a preview deployment both run
 * with `NODE_ENV=production`.
 */
export const resolveSiteOrigin = (): string => {
  const configured = serverEnv.appBaseUrl;
  const environment = serverEnv.appEnv;

  if (environment === "production") {
    const origin = configured ? withoutTrailingSlash(configured) : null;

    if (origin !== CANONICAL_SITE_ORIGIN) {
      throw new Error(
        `The configured site origin is ${origin ?? "unset"}, but production publishes exactly ` +
          `${CANONICAL_SITE_ORIGIN}. Every canonical URL, Open Graph URL and sitemap entry is ` +
          `built from this value, so a well-formed wrong one points the whole launch somewhere ` +
          `else and nothing downstream can detect it. Set APP_BASE_URL to the canonical origin.`,
      );
    }

    return origin;
  }

  if (!configured) {
    return "http://localhost:3000";
  }

  const origin = withoutTrailingSlash(configured);

  if (environment !== "local" && environment !== "test" && isLoopbackOrigin(origin)) {
    throw new Error(
      `The configured site origin is ${origin}, which is this machine rather than a reachable ` +
        `site. A ${environment} deployment is supposed to describe itself, and every crawler-facing ` +
        `URL it emits would point at whoever fetched it.`,
    );
  }

  return origin;
};

/** Absolute URL for a site-relative path, for the crawler-facing surfaces above. */
export const absoluteSiteUrl = (path: string): string => `${resolveSiteOrigin()}${path}`;
