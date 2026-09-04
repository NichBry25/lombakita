import type { MetadataRoute } from "next";
import { DISALLOWED_PATH_PREFIXES } from "@/config/indexable-routes";
import { absoluteSiteUrl } from "@/config/site-url";

/**
 * `/robots.txt`, generated rather than kept as a static file so its disallow list and the sitemap
 * are built from one declaration (`@/config/indexable-routes`) and cannot drift apart.
 *
 * The rules here are a crawl hint. They stop a well-behaved crawler spending its budget on auth,
 * diagnostic and role-gated surfaces, but they are not what keeps a page out of an index — a
 * disallowed URL can still be indexed from a link elsewhere, because the crawler never fetches it
 * and so never reads its `noindex`. The withholding default in the root layout is the enforcement.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [...DISALLOWED_PATH_PREFIXES],
    },
    sitemap: absoluteSiteUrl("/sitemap.xml"),
    host: absoluteSiteUrl(""),
  };
}
