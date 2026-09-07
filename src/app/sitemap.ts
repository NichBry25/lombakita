import type { MetadataRoute } from "next";
import { STATIC_INDEXABLE_PATHS } from "@/config/indexable-routes";
import { absoluteSiteUrl } from "@/config/site-url";
import { listSitemapCompetitions } from "@/server/competitions/competition-public-service";
import { listSitemapInstitutions } from "@/server/institution-workspace/institution-public-service";

// The sitemap is read by crawlers on their own schedule, not per visitor, and enumerating every
// published competition is two full-table reads. An hour-old sitemap costs a crawler nothing —
// it revisits the pages it already knows — so this is cached rather than rebuilt per request.
export const revalidate = 3600;

/**
 * `/sitemap.xml`, enumerated from the database.
 *
 * A static file cannot do this job: the set of indexable pages is mostly competitions and
 * organizers, which change without anyone editing the repository. The two queries behind it decide
 * publication state in SQL, so an unpublished, archived, soft-deleted or suspended entity is never
 * a row this function has to remember to drop.
 *
 * What is here is exactly what `@/config/indexable-routes` says may be indexed. Nothing else
 * belongs, and `indexable-routes.test.ts` fails if anything listed here is also disallowed.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [competitions, institutions] = await Promise.all([
    listSitemapCompetitions(),
    listSitemapInstitutions(),
  ]);

  // NO `changeFrequency` OR `priority`. Both were invented here — nobody measured how often a
  // competition page changes, and the priorities were a guess at relative importance. Google
  // ignores both outright, so they added nothing a crawler could use while reading, to anyone
  // opening this file later, as decisions someone had made. `lastModified` stays because it is a
  // fact: it comes from the row's own `updated_at`.
  const staticEntries = STATIC_INDEXABLE_PATHS.map((path) => ({
    url: absoluteSiteUrl(path),
  }));

  const competitionEntries = competitions.map((competition) => ({
    url: absoluteSiteUrl(`/competitions/${competition.institutionSlug}/${competition.slug}`),
    lastModified: competition.updatedAt,
  }));

  const institutionEntries = institutions.map((institution) => ({
    url: absoluteSiteUrl(`/institution/${institution.slug}`),
    lastModified: institution.updatedAt,
  }));

  return [...staticEntries, ...competitionEntries, ...institutionEntries];
}
