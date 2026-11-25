import { sql } from "drizzle-orm";
import type { InstitutionType } from "@/server/db/schema";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";

// Single source of truth for resolving a user-facing institution display name.
//
// An institution's name is its stored display_name. A personal institution may store NULL, and its
// name is then derived from the username of its earliest active owner. Every surface that shows an
// institution name to a user MUST route the raw column through this helper.

export type InstitutionDisplayNameSource = {
  displayName: string | null;
  institutionType: InstitutionType | null;
};

// Callers that may carry a personal institution with no stored name MUST batch-load or join the
// owner user and pass it here. The no-owner branch is a defensive fallback.
export const getInstitutionDisplayName = (
  institution: InstitutionDisplayNameSource,
  ownerUser?: { username: string | null } | null,
): string => {
  if (institution.displayName !== null) {
    return institution.displayName;
  }
  if (!isPersonalInstitutionType(institution.institutionType)) {
    return "";
  }
  const username = ownerUser?.username ?? null;
  return username ? `${username}'s Institution` : "Personal Institution";
};

// Reusable correlated scalar subquery that yields the username of an institution's active owner.
// Selects the earliest active institution_owner (deterministic, LIMIT 1) — for a personal
// institution this is the single member; for a full institution it returns some owner's username,
// which getInstitutionDisplayName ignores. LIMIT 1 keeps it row-multiplication-safe, unlike a JOIN
// to a multi-owner institution.
//
// Usable in any query whose FROM/JOIN set includes the `institutions` table. The correlation MUST
// reference the outer table as the literal text `institutions.id`: interpolating the Drizzle column
// (${institutions.id}) renders an unqualified `"id"` that Postgres cannot resolve to the outer row.
// This mirrors the working correlated-subquery form in verification-service.ts / lookup-service.ts.
export const institutionOwnerUsernameSql = sql<string | null>`(
  SELECT u.username FROM institution_memberships im
  INNER JOIN users u ON u.id = im.user_id
  WHERE im.institution_id = institutions.id
    AND im.membership_role = 'institution_owner'
    AND im.status = 'active'
  ORDER BY im.created_at ASC
  LIMIT 1
)`;
