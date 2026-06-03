import { eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { institutions, users } from "@/server/db/schema";
import type { InstitutionVerificationStatus } from "@/server/db/schema";
import type { AppRole } from "@/lib/access/roles";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/moderation/lookup-service");

export type UserLookupResult = {
  id: string;
  email: string;
  name: string | null;
  appRole: AppRole;
  candidateVerifiedAt: Date | null;
  recruiterVerifiedAt: Date | null;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  createdAt: Date;
};

export type InstitutionLookupResult = {
  id: string;
  name: string;
  slug: string;
  verificationStatus: InstitutionVerificationStatus;
  verifiedAt: Date | null;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  createdAt: Date;
};

// Support lookup by email (case-insensitive). Returns null when no account matches.
export const lookupUserByEmail = async (
  email: string,
  db: Database = getDb(),
): Promise<UserLookupResult | null> => {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      appRole: users.role,
      candidateVerifiedAt: users.candidateVerifiedAt,
      recruiterVerifiedAt: users.recruiterVerifiedAt,
      suspendedAt: users.suspendedAt,
      suspensionReason: users.suspensionReason,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);

  return row ?? null;
};

// Support lookup by institution slug. Owner identity resolved via the earliest active
// institution_owner membership (correlated subquery — guarantees one row).
export const lookupInstitutionBySlug = async (
  slug: string,
  db: Database = getDb(),
): Promise<InstitutionLookupResult | null> => {
  const [row] = await db
    .select({
      id: institutions.id,
      name: institutions.displayName,
      slug: institutions.slug,
      verificationStatus: institutions.verificationStatus,
      verifiedAt: institutions.verifiedAt,
      suspendedAt: institutions.suspendedAt,
      suspensionReason: institutions.suspensionReason,
      createdAt: institutions.createdAt,
      // NOTE: the correlation must reference the outer table as the literal text
      // `institutions.id`. Interpolating the Drizzle column (${institutions.id}) renders an
      // unqualified `"id"` inside the subquery, which Postgres cannot resolve to the outer row —
      // this mirrors the working correlated-subquery form in verification-service.ts.
      ownerEmail: sql<string | null>`(
        SELECT u.email FROM institution_memberships im
        INNER JOIN users u ON u.id = im.user_id
        WHERE im.institution_id = institutions.id
          AND im.membership_role = 'institution_owner'
          AND im.status = 'active'
        ORDER BY im.created_at ASC
        LIMIT 1
      )`,
      ownerName: sql<string | null>`(
        SELECT u.name FROM institution_memberships im
        INNER JOIN users u ON u.id = im.user_id
        WHERE im.institution_id = institutions.id
          AND im.membership_role = 'institution_owner'
          AND im.status = 'active'
        ORDER BY im.created_at ASC
        LIMIT 1
      )`,
    })
    .from(institutions)
    .where(eq(institutions.slug, slug))
    .limit(1);

  return row ?? null;
};

// F20: Resolve an institution by slug OR display name (case-insensitive). Returns the first
// match when multiple institutions share a display name. Slug match takes natural precedence
// because the ORDER of the OR condition checks slug first in index-scan plans.
export const lookupInstitutionBySlugOrName = async (
  query: string,
  db: Database = getDb(),
): Promise<InstitutionLookupResult | null> => {
  const [row] = await db
    .select({
      id: institutions.id,
      name: institutions.displayName,
      slug: institutions.slug,
      verificationStatus: institutions.verificationStatus,
      verifiedAt: institutions.verifiedAt,
      suspendedAt: institutions.suspendedAt,
      suspensionReason: institutions.suspensionReason,
      createdAt: institutions.createdAt,
      ownerEmail: sql<string | null>`(
        SELECT u.email FROM institution_memberships im
        INNER JOIN users u ON u.id = im.user_id
        WHERE im.institution_id = institutions.id
          AND im.membership_role = 'institution_owner'
          AND im.status = 'active'
        ORDER BY im.created_at ASC
        LIMIT 1
      )`,
      ownerName: sql<string | null>`(
        SELECT u.name FROM institution_memberships im
        INNER JOIN users u ON u.id = im.user_id
        WHERE im.institution_id = institutions.id
          AND im.membership_role = 'institution_owner'
          AND im.status = 'active'
        ORDER BY im.created_at ASC
        LIMIT 1
      )`,
    })
    .from(institutions)
    .where(sql`lower(${institutions.slug}) = lower(${query}) OR lower(${institutions.displayName}) = lower(${query})`)
    .limit(1);

  return row ?? null;
};
