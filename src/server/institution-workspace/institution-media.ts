import { sql } from "drizzle-orm";
import type { InstitutionType } from "@/server/db/schema";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";

// Single source of truth for resolving an institution's logo and banner, mirroring the
// display-name derivation in institution-display-name.ts and existing for the same reason.
//
// A personal institution does NOT store either image: it has no identity separate from the person
// who owns it, so it shows that person's own profile photo and banner. Resolving at read time (as
// opposed to copying keys at creation) means a change to the owner's profile is reflected
// immediately, with nothing to keep in sync. Full institutions store and use their own keys.
//
// Every surface that shows institution imagery MUST route the raw columns through this helper. A
// raw read of institutions.logo_r2_key on a personal institution yields NULL and renders a
// placeholder where the owner's photo belongs.

export type InstitutionMediaSource = {
  institutionType: InstitutionType | null;
  logoR2Key: string | null;
  bannerR2Key: string | null;
};

export type InstitutionOwnerMedia = {
  avatarR2Key: string | null;
  bannerR2Key: string | null;
};

export type InstitutionMediaKeys = {
  logoKey: string | null;
  bannerKey: string | null;
};

// Picks which stored object keys an institution actually displays. Callers that may carry a
// personal institution MUST join the owner's profile and pass `ownerMedia`; the no-owner branch is
// a defensive fallback for paths that can never carry one.
export const resolveInstitutionMediaKeys = (
  institution: InstitutionMediaSource,
  ownerMedia?: InstitutionOwnerMedia | null,
): InstitutionMediaKeys => {
  if (isPersonalInstitutionType(institution.institutionType)) {
    return {
      logoKey: ownerMedia?.avatarR2Key ?? null,
      bannerKey: ownerMedia?.bannerR2Key ?? null,
    };
  }
  return { logoKey: institution.logoR2Key, bannerKey: institution.bannerR2Key };
};

// Correlated scalar subqueries yielding the owner's profile image keys, matching the shape and the
// constraints of institutionOwnerUsernameSql: usable in any query whose FROM/JOIN set includes
// `institutions`, and the correlation MUST reference the outer table as the literal text
// `institutions.id` (interpolating the Drizzle column renders an unqualified `"id"` that Postgres
// cannot resolve to the outer row).
const ownerProfileColumnSql = (column: "avatar_r2_key" | "banner_r2_key") => sql<string | null>`(
  SELECT up.${sql.raw(column)} FROM institution_memberships im
  INNER JOIN users u ON u.id = im.user_id
  INNER JOIN user_profiles up ON up.user_id = u.id
  WHERE im.institution_id = institutions.id
    AND im.membership_role = 'institution_owner'
    AND im.status = 'active'
  ORDER BY im.created_at ASC
  LIMIT 1
)`;

export const institutionOwnerAvatarKeySql = ownerProfileColumnSql("avatar_r2_key");
export const institutionOwnerBannerKeySql = ownerProfileColumnSql("banner_r2_key");
