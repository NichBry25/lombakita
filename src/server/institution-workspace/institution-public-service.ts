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
import { isInstitutionMemberBySlug } from "@/server/institution-members/member-service";

/**
 * Who is asking for an institution's public page.
 *
 * The contact fields are the reason this exists. An unverified institution's contact details are
 * withheld from the open web — publishing a phone number for an organizer nobody has checked is the
 * exposure this closes — but its own people keep working during review, so membership restores them.
 *
 * `isPlatformOps` is supplied by the caller from the session (`session.user.role`), which is the
 * same source `requireSessionRole(["platform_ops"])` reads. It is not read here because this module
 * has no session, and it is deliberately a plain boolean rather than a role string: the only
 * question asked of it is whether this viewer counts as platform ops.
 */
export type InstitutionPublicViewer = {
  userId: string | null;
  isPlatformOps: boolean;
  /** `?tampilan=publik` — the owner looking at their own page as a stranger would. */
  isPreview: boolean;
};

export const ANONYMOUS_INSTITUTION_VIEWER: InstitutionPublicViewer = {
  userId: null,
  isPlatformOps: false,
  isPreview: false,
};

/**
 * What the caller may render in the contact section, and which notice belongs above it.
 *
 * The contact fields themselves are already nulled by the time this is read, so a component that
 * ignores this value shows nothing rather than leaking: the decision is made here, on the server,
 * against the database, and the client is never handed a contact it may not render.
 *
 * - `public`         — verified institution. Contacts shown, no notice.
 * - `members_only`   — unverified, viewer is an insider. Contacts shown, and the notice names which
 *                       kind of insider: a member of the institution, or Lombakita's own team
 *                       looking in with no membership at all.
 * - `preview_hidden` — unverified, insider, but the viewer is in public preview. Contacts hidden.
 * - `hidden`         — nobody to show them to (or nothing to show). Section omitted entirely.
 */
export type InstitutionContactDisclosure =
  | { kind: "public" }
  | {
      kind: "members_only";
      /** True when this viewer sees the contacts as platform ops rather than as a member. */
      viewerIsPlatformOps: boolean;
    }
  | { kind: "preview_hidden" }
  | { kind: "hidden" };

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
  contactDisclosure: InstitutionContactDisclosure;
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

/**
 * Whether an institution has earned indexing, in SQL, for the sitemap's WHERE clause.
 *
 * STRICTLY NARROWER THAN THE RENDER PREDICATE, and the gap is the whole point (DEC-0158). Publishing
 * is gated on verification for PAID competitions only, so a free competition publishes from an
 * unverified institution — which means that institution's page must keep rendering. A crawler is a
 * different question: nothing about an unverified organizer needs to be in a search result, and
 * every page advertised here is one the operator has stood behind. So the page renders and the
 * sitemap does not list it, and the two are not two answers to one question.
 *
 * The personal exclusion is page shape rather than visibility, carried over from the inline clause
 * this replaces: `/institution/<personal-slug>` redirects to the owner's profile, which DEC-0196
 * withholds from search. Listing it would advertise a URL whose only purpose is to bounce a crawler
 * at a page it may not index.
 */
export const buildIndexableInstitutionCondition = (): SQL =>
  and(
    buildPublicInstitutionCondition(),
    ne(institutions.institutionType, "personal" satisfies InstitutionType),
    eq(institutions.verificationStatus, "verified" satisfies InstitutionVerificationStatus),
  )!;

/**
 * The same rule as `buildIndexableInstitutionCondition`, for a row the caller already holds.
 *
 * TWO SPELLINGS, ONE RULE, and they are kept in step by a test rather than by proximity —
 * `sitemap-db.integration.test.ts` walks every combination of verification status, institution type
 * and suspension against the database and asserts the sitemap's membership and this function's
 * answer agree. The duplication is unavoidable: the sitemap's question is asked of Postgres in a
 * WHERE clause, and the page's is asked of a row already in memory, and a JS predicate cannot be a
 * WHERE clause (nor the reverse). What was NOT acceptable was the previous arrangement, where two
 * independently-written expressions agreed by luck and nothing made them go on agreeing.
 */
export const isIndexableInstitution = (institution: {
  institutionType: InstitutionType;
  isVerified: boolean;
}): boolean => !isPersonalInstitutionType(institution.institutionType) && institution.isVerified;

/**
 * Which contact fields this viewer may see, and what to say above them.
 *
 * Read the four outcomes on `InstitutionContactDisclosure`. The one that is easy to get wrong is
 * `preview_hidden`: `?tampilan=publik` exists so an owner can see their page AS A STRANGER WOULD,
 * and an owner who is shown their own contacts under that flag is looking at a page no stranger
 * gets — which defeats the only reason the flag exists.
 *
 * An owner or staff member is an insider, and `members_only` is where an insider's view lands — but
 * the notice carries no route into the verification flow for them, because the only page that
 * renders this decision serves the workspace hub to owner and staff and reserves the public view
 * for a preview in which the disclosure is `preview_hidden` (LAUNCH-D161).
 */
const resolveContactDisclosure = async (
  institution: {
    slug: string;
    verificationStatus: InstitutionVerificationStatus;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
  },
  viewer: InstitutionPublicViewer,
  db: Database,
): Promise<InstitutionContactDisclosure> => {
  if (institution.verificationStatus === ("verified" satisfies InstitutionVerificationStatus)) {
    return { kind: "public" };
  }

  const hasAnyContact =
    Boolean(institution.contactName) ||
    Boolean(institution.contactEmail) ||
    Boolean(institution.contactPhone);

  // Nothing to disclose. The section is omitted for every viewer, exactly as it is for an
  // institution that never filled the fields in.
  if (!hasAnyContact) return { kind: "hidden" };

  const isMember =
    viewer.userId !== null
      ? await isInstitutionMemberBySlug(viewer.userId, institution.slug, db)
      : false;
  if (!isMember && !viewer.isPlatformOps) return { kind: "hidden" };

  if (viewer.isPreview) return { kind: "preview_hidden" };

  // `isMember` is already known false for the platform-ops viewer that reached here, so this names
  // the account whose access is platform ops rather than a relationship with the institution.
  return { kind: "members_only", viewerIsPlatformOps: !isMember };
};

export const getPublicInstitution = async (
  institutionSlug: string,
  viewer: InstitutionPublicViewer = ANONYMOUS_INSTITUTION_VIEWER,
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
      // A personal institution is never verified, so the disclosure rule would say `members_only`
      // for its own owner — and that answer would be misleading, because this page never renders a
      // contact section at all: the caller redirects to the owner's profile before the view is
      // reached. `hidden` is what is true of the page, which is the only thing a disclosure is for.
      contactDisclosure: { kind: "hidden" },
      websiteUrl: null,
      socialLinks: [],
      personalOwnerUsername: row.ownerUsername,
    };
  }

  const [media, socialLinks, contactDisclosure] = await Promise.all([
    resolveInstitutionMediaUrls(row, {
      avatarR2Key: row.ownerAvatarKey,
      bannerR2Key: row.ownerBannerKey,
    }),
    db
      .select({ platform: institutionSocialLinks.platform, url: institutionSocialLinks.url })
      .from(institutionSocialLinks)
      .where(eq(institutionSocialLinks.institutionId, row.id)),
    resolveContactDisclosure(
      {
        slug: row.slug,
        verificationStatus: row.verificationStatus,
        contactName: row.contactName,
        contactEmail: row.contactEmail,
        contactPhone: row.contactPhone,
      },
      viewer,
      db,
    ),
  ]);

  // THE FIELDS ARE NULLED HERE, NOT HIDDEN IN MARKUP. A component that renders nothing for a null
  // contact cannot leak one, and a payload inspected in a browser network tab carries no contact for
  // a viewer who may not see it. Nulling in the view would put the value on the wire first.
  const contactsVisible =
    contactDisclosure.kind === "public" || contactDisclosure.kind === "members_only";

  return {
    slug: row.slug,
    name: getInstitutionDisplayName(row, { username: row.ownerUsername }),
    institutionType: row.institutionType,
    description: row.description,
    about: row.about,
    isVerified: row.verificationStatus === ("verified" satisfies InstitutionVerificationStatus),
    logoUrl: media.logoUrl,
    bannerUrl: media.bannerUrl,
    contactName: contactsVisible ? row.contactName : null,
    contactEmail: contactsVisible ? row.contactEmail : null,
    contactPhone: contactsVisible ? row.contactPhone : null,
    contactDisclosure,
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
 * The rule — render predicate, minus personal institutions, minus anything unverified — is applied
 * in the WHERE clause rather than by filtering the result, so an organizer the operator has not
 * stood behind cannot be advertised by a query that simply returned more rows than the caller
 * remembered to drop. See `buildIndexableInstitutionCondition` for why the sitemap is narrower than
 * the page and why that is not a disagreement.
 */
export const listSitemapInstitutions = async (
  db: Database = getDb(),
): Promise<SitemapInstitutionEntry[]> => {
  const rows = await db
    .select({ slug: institutions.slug, updatedAt: institutions.updatedAt })
    .from(institutions)
    .where(buildIndexableInstitutionCondition());

  return rows.map((row) => ({ slug: row.slug, updatedAt: row.updatedAt }));
};
