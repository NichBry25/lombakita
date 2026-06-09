import { sql } from "drizzle-orm";
import type { InstitutionType } from "@/server/db/schema";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";

// Single source of truth for resolving a user-facing institution display name.
//
// A personal institution does NOT store a display name (institutions.display_name is NULL). Its name
// derives from the owner's current username at read time, so a future username change is reflected
// automatically without a stored-name backfill. Full/legacy institutions (type !== 'personal',
// including the undeclared NULL type) carry a non-null stored name and use it directly.
//
// Every surface that shows an institution name to a user MUST route the raw column through this
// helper. A raw read of institutions.display_name on a name-bearing surface produces a NULL for
// personal institutions and, once username-change ships, a stale name — both are bugs.

export type InstitutionDisplayNameSource = {
  displayName: string | null;
  institutionType: InstitutionType | null;
};

// Render the resolved name for an institution. For a personal institution the owner username drives
// the name; callers that may carry a personal institution MUST batch-load / join the owner user and
// pass it here. The no-owner branch is a defensive fallback for paths that can never carry a
// personal institution (e.g. invitation dispatch — personal institutions cannot issue invitations).
export const getInstitutionDisplayName = (
  institution: InstitutionDisplayNameSource,
  ownerUser?: { username: string | null } | null,
): string => {
  if (isPersonalInstitutionType(institution.institutionType)) {
    const username = ownerUser?.username ?? null;
    return username ? `${username}'s Institution` : "Personal Institution";
  }
  return institution.displayName ?? "";
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
