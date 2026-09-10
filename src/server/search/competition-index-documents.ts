import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/search/competition-index-documents");

import { and, eq, isNull } from "drizzle-orm";
import { competitions, institutions, type InstitutionType } from "@/server/db/schema";
import {
  getInstitutionDisplayName,
  institutionOwnerUsernameSql,
} from "@/server/institution-workspace/institution-display-name";
import type { CompetitionIndexDocument } from "@/server/search/competition-index";

/**
 * How a competition row becomes an index document, in one place.
 *
 * The publish/edit sync job writes documents one at a time; a full rebuild writes them in bulk.
 * Those are different queries and stay different, but the COLUMN SET and the ROW-TO-DOCUMENT
 * MAPPING are one piece of knowledge, and they were written out three times. A rebuild whose
 * mapping has drifted from the sync job's produces an index that disagrees with itself depending
 * on which path last touched a row — invisible in both, because each is individually correct.
 */

/**
 * The columns every index document is built from.
 *
 * `institutionOwnerUsername` is a correlated subquery rather than a join, so it is safe against a
 * multi-owner institution multiplying rows. It requires `institutions` in the FROM/JOIN set.
 */
export const COMPETITION_INDEX_COLUMNS = {
  id: competitions.id,
  title: competitions.title,
  slug: competitions.slug,
  category: competitions.category,
  mode: competitions.mode,
  registrationEndAt: competitions.registrationEndAt,
  createdAt: competitions.createdAt,
  isFeatured: competitions.isFeatured,
  featuredOrder: competitions.featuredOrder,
  institutionSlug: institutions.slug,
  institutionDisplayName: institutions.displayName,
  institutionType: institutions.institutionType,
  institutionOwnerUsername: institutionOwnerUsernameSql,
} as const;

export type CompetitionIndexRow = {
  id: string;
  title: string;
  slug: string;
  category: string | null;
  mode: string | null;
  registrationEndAt: Date | null;
  createdAt: Date;
  isFeatured: boolean;
  featuredOrder: number | null;
  institutionSlug: string;
  institutionDisplayName: string | null;
  institutionType: InstitutionType | null;
  institutionOwnerUsername: string | null;
};

/**
 * Which competitions belong in the index: published, not soft-deleted.
 *
 * Shared so a rebuild cannot index a population the sync job would not have written. A rebuild that
 * included drafts would publish them to every search result at once.
 */
export const publishedCompetitionsFilter = () =>
  and(eq(competitions.status, "published"), isNull(competitions.deletedAt));

/**
 * `deadline` is UNIX epoch SECONDS because Meilisearch range filters are numeric; a null
 * `registrationEndAt` means the competition never closes, which is not the same as a zero.
 *
 * `institutionName` resolves through `getInstitutionDisplayName` because a personal institution
 * stores NULL and derives its name from the owner's username. Reading the raw column here would put
 * an empty name on every personal institution's competitions in search.
 */
export const toCompetitionIndexDocument = (row: CompetitionIndexRow): CompetitionIndexDocument => ({
  id: row.id,
  title: row.title,
  slug: row.slug,
  category: row.category ?? null,
  mode: row.mode ?? null,
  deadline: row.registrationEndAt ? Math.floor(row.registrationEndAt.getTime() / 1000) : null,
  createdAt: row.createdAt.toISOString(),
  isFeatured: row.isFeatured,
  featuredOrder: row.featuredOrder ?? null,
  institutionSlug: row.institutionSlug,
  institutionName: getInstitutionDisplayName(
    { displayName: row.institutionDisplayName, institutionType: row.institutionType },
    { username: row.institutionOwnerUsername },
  ),
  status: "published",
});
