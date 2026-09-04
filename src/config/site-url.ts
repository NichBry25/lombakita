import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";

/**
 * The absolute origin this deployment is reachable at, for the places that cannot use a relative
 * path: `metadataBase`, Open Graph URLs, robots.txt's sitemap pointer, and the sitemap's own
 * entries. A sitemap of relative paths is not a sitemap.
 *
 * `APP_BASE_URL` is consulted first because production pins it to the canonical apex
 * (`env-shape.ts`), which is the one value that is right for a crawler. `AUTH_URL` follows because
 * preview deployments set it per deployment, and the public fallbacks below it keep local
 * development and tests working without either.
 *
 * Adds no environment variable of its own: every key here is already required and probed by the
 * deploy gate.
 */
export const resolveSiteOrigin = (): string => {
  const configured =
    serverEnv.appBaseUrl ?? serverEnv.authUrl ?? publicEnv.appUrl ?? "http://localhost:3000";

  // Trailing slashes make `new URL(path, origin)` and plain concatenation disagree, and the
  // sitemap would emit both shapes for the same page.
  return configured.replace(/\/+$/, "");
};

/** Absolute URL for a site-relative path, for the crawler-facing surfaces above. */
export const absoluteSiteUrl = (path: string): string => `${resolveSiteOrigin()}${path}`;
