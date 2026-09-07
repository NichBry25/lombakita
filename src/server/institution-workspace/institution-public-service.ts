import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-workspace/institution-public-service");

import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionSocialLinks,
  institutions,
  type InstitutionType,
  type InstitutionVerificationStatus,
} from "@/server/db/schema";
import {
  getInstitutionDisplayName,
  institutionOwnerUsernameSql,
} from "@/server/institution-workspace/institution-display-name";
import {
  institutionOwnerAvatarKeySql,
  institutionOwnerBannerKeySql,
} from "@/server/institution-workspace/institution-media";
import { resolveInstitutionMediaUrls } from "@/server/institution-workspace/institution-media-urls";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";
import { parseInstitutionSlugParam } from "@/server/institution-workspace/institution-core";

// What a visitor with no relationship to an institution sees. Deliberately excludes everything the
// workspace surfaces (membership, verification submissions, audit trail, drafts) — this is the
// organizer's public face, not a read-only copy of their console.
export type PublicInstitution = {
  slug: string;
  name: string;
  institutionType: InstitutionType;
  description: string | null;
  about: string | null;
  isVerified: boolean;
  logoUrl: string | null;
  bannerUrl: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  socialLinks: Array<{ platform: string; url: string }>;
  // A personal institution has no public page of its own — the caller redirects to this username's
  // profile instead. Null only when the institution has somehow lost its owner membership.
  personalOwnerUsername: string | null;
};

/**
 * Whether an institution's public face is visible at all.
 *
 * Suspension is the operational takedown axis, so a suspended institution is withheld entirely —
 * its public page should not keep serving while it is switched off.
 *
 * ONE DEFINITION, in SQL, for every caller. This used to be a JavaScript post-filter here and a
 * separately-written WHERE clause in `listSitemapInstitutions`: two expressions of the same rule,
 * in two languages, at two layers, with nothing keeping them in step. They agreed, and nothing made
 * them go on agreeing — and the sitemap is the copy nobody opens, so it is the copy that would have
 * drifted unnoticed. Mirrors `buildPublicVisibilityCondition` on the competition side, which is
 * already shared by its listing, its detail page and its sitemap query.
 *
 * Deliberately NOT including the personal-institution exclusion. That is not a visibility rule —
 * a personal institution's page is reachable and simply redirects to its owner's profile — so it
 * belongs to the one caller that cares about page shape rather than to this predicate.
 */
export const buildPublicInstitutionCondition = (): SQL => isNull(institutions.suspendedAt)!;

export const getPublicInstitution = async (
  institutionSlug: string,
  db: Database = getDb(),
): Promise<PublicInstitution | null> => {
  const normalizedSlug = parseInstitutionSlugParam(institutionSlug);

  const [row] = await db
    .select({
      id: institutions.id,
      slug: institutions.slug,
      displayName: institutions.displayName,
      institutionType: institutions.institutionType,
      description: institutions.description,
      about: institutions.about,
      verificationStatus: institutions.verificationStatus,
      suspendedAt: institutions.suspendedAt,
      logoR2Key: institutions.logoR2Key,
      bannerR2Key: institutions.bannerR2Key,
      contactName: institutions.contactName,
      contactEmail: institutions.contactEmail,
      contactPhone: institutions.contactPhone,
      websiteUrl: institutions.websiteUrl,
      ownerUsername: institutionOwnerUsernameSql,
      ownerAvatarKey: institutionOwnerAvatarKeySql,
      ownerBannerKey: institutionOwnerBannerKeySql,
    })
    .from(institutions)
    .where(and(eq(institutions.slug, normalizedSlug), buildPublicInstitutionCondition()))
    .limit(1);

  if (!row) return null;

  const isPersonal = isPersonalInstitutionType(row.institutionType);

  // A personal institution's page is a redirect, so its imagery and links are never rendered —
  // skip the presign round-trips and the social-link query entirely.
  if (isPersonal) {
    return {
      slug: row.slug,
      name: getInstitutionDisplayName(row, { username: row.ownerUsername }),
      institutionType: row.institutionType,
      description: row.description,
      about: row.about,
      isVerified: row.verificationStatus === ("verified" satisfies InstitutionVerificationStatus),
      logoUrl: null,
      bannerUrl: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      websiteUrl: null,
      socialLinks: [],
      personalOwnerUsername: row.ownerUsername,
    };
  }

  const [media, socialLinks] = await Promise.all([
    resolveInstitutionMediaUrls(row, {
      avatarR2Key: row.ownerAvatarKey,
      bannerR2Key: row.ownerBannerKey,
    }),
    db
      .select({ platform: institutionSocialLinks.platform, url: institutionSocialLinks.url })
      .from(institutionSocialLinks)
      .where(eq(institutionSocialLinks.institutionId, row.id)),
  ]);

  return {
    slug: row.slug,
    name: getInstitutionDisplayName(row, { username: row.ownerUsername }),
    institutionType: row.institutionType,
    description: row.description,
    about: row.about,
    isVerified: row.verificationStatus === ("verified" satisfies InstitutionVerificationStatus),
    logoUrl: media.logoUrl,
    bannerUrl: media.bannerUrl,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    websiteUrl: row.websiteUrl,
    socialLinks,
    personalOwnerUsername: null,
  };
};

/** One organizer page in the sitemap. */
export type SitemapInstitutionEntry = {
  slug: string;
  updatedAt: Date;
};

/**
 * Every institution whose public page a crawler is invited to fetch.
 *
 * Both exclusions are applied in the WHERE clause rather than by filtering the result, so a
 * suspended organizer cannot be advertised by a query that simply returned more rows than the
 * caller remembered to drop.
 *
 * A personal institution has no public page of its own — `/institution/<slug>` redirects to the
 * owner's `/[username]` profile, which is deliberately withheld from search (DEC-0196). Listing it
 * would advertise a URL whose only purpose is to bounce a crawler at a page it may not index.
 */
export const listSitemapInstitutions = async (
  db: Database = getDb(),
): Promise<SitemapInstitutionEntry[]> => {
  const rows = await db
    .select({ slug: institutions.slug, updatedAt: institutions.updatedAt })
    .from(institutions)
    .where(
      and(
        buildPublicInstitutionCondition(),
        // Page shape, not visibility: a personal institution's page redirects to its owner's
        // profile, which DEC-0196 withholds from search.
        ne(institutions.institutionType, "personal" satisfies InstitutionType),
      ),
    );

  return rows.map((row) => ({ slug: row.slug, updatedAt: row.updatedAt }));
};
