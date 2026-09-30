import type { MetadataRoute } from "next";
import { STATIC_INDEXABLE_PATHS } from "@/config/indexable-routes";
import { absoluteSiteUrl } from "@/config/site-url";
import { listSitemapCompetitions } from "@/server/competitions/competition-public-service";
import { listSitemapInstitutions } from "@/server/institution-workspace/institution-public-service";

// LAUNCH-D1: withdrawal must leave the sitemap within the same window the homepage uses, or the two
// disagree about what is published — the homepage stops advertising a competition while the sitemap
// still hands it to a crawler. This one constant covers every membership-changing path, the ones
// that exist and the ones added later, because they all funnel through this function rather than
// each remembering to revalidate. The window is short enough for that agreement and long enough that
// enumerating every published competition is not two full-table reads per crawler request.
export const revalidate = 300;

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
