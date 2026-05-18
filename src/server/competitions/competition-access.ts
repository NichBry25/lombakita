import { and, eq, isNull } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  institutionMemberships,
  institutions,
  type CompetitionCategory,
  type CompetitionMode,
  type CompetitionStatus,
  type InstitutionMembershipRole,
  type InstitutionVerificationStatus,
} from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { CompetitionError } from "@/server/competitions/competition-core";

assertServerOnly("server/competitions/competition-access");

// Required-role contract for assertCompetitionAccess.
//   "member" — any active institution_owner or institution_staff in the owning institution
//   "admin"  — only active institution_owner in the owning institution
// institution_member excluded per CCR-09: no operational access to competition surfaces.
// Mutating routes (PATCH fields, DELETE) require "member".
// Status transitions and publish/unpublish/archive require "admin".
export type CompetitionAccessLevel = "member" | "admin";

// Output projection for every public competition response. fee_amount, fee_currency, and
// is_featured are intentionally excluded — they are schema-present but API-blocked until
// Phase 5.5 (featured) and Phase 7 (payments). All select() / .returning() calls that flow
// into a route response must use this projection so deferred fields cannot leak.
// CompetitionRow is the inferred shape of this projection and is the public service-layer type.
export const PUBLIC_COMPETITION_COLUMNS = {
  id: competitions.id,
  institutionId: competitions.institutionId,
  createdByUserId: competitions.createdByUserId,
  slug: competitions.slug,
  title: competitions.title,
  description: competitions.description,
  status: competitions.status,
  category: competitions.category,
  mode: competitions.mode,
  minTeamSize: competitions.minTeamSize,
  maxTeamSize: competitions.maxTeamSize,
  registrationStartAt: competitions.registrationStartAt,
  registrationEndAt: competitions.registrationEndAt,
  eventStartAt: competitions.eventStartAt,
  eventEndAt: competitions.eventEndAt,
  publishedAt: competitions.publishedAt,
  archivedAt: competitions.archivedAt,
  deletedAt: competitions.deletedAt,
  createdAt: competitions.createdAt,
  updatedAt: competitions.updatedAt,
} as const;

// Explicit type — keys here must stay in lockstep with PUBLIC_COMPETITION_COLUMNS above.
// fee_amount, fee_currency, is_featured are intentionally absent (DEC-0022).
export type CompetitionRow = {
  id: string;
  institutionId: string;
  createdByUserId: string | null;
  slug: string;
  title: string;
  description: string;
  status: CompetitionStatus;
  category: CompetitionCategory | null;
  mode: CompetitionMode | null;
  minTeamSize: number | null;
  maxTeamSize: number | null;
  registrationStartAt: Date | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  eventEndAt: Date | null;
  publishedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CompetitionAccessResult = {
  competition: CompetitionRow;
  membershipRole: InstitutionMembershipRole | null; // null when actor is platform_ops read
};

// institution_member excluded per CCR-09: member role has no operational competition access.
export const MEMBER_ROLES: readonly InstitutionMembershipRole[] = [
  "institution_owner",
  "institution_staff",
];

const loadCompetitionById = async (
  competitionId: string,
  db: Database,
): Promise<CompetitionRow | null> => {
  const [row] = await db
    .select(PUBLIC_COMPETITION_COLUMNS)
    .from(competitions)
    .where(and(eq(competitions.id, competitionId), isNull(competitions.deletedAt)))
    .limit(1);
  return row ?? null;
};

const findActiveMembershipRole = async (
  actorUserId: string,
  institutionId: string,
  db: Database,
): Promise<InstitutionMembershipRole | null> => {
  const [row] = await db
    .select({ role: institutionMemberships.membershipRole })
    .from(institutionMemberships)
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.userId, actorUserId),
        eq(institutionMemberships.status, "active"),
      ),
    )
    .limit(1);
  return row?.role ?? null;
};

// Loads the competition (404 if missing or soft-deleted) and verifies that the actor has the
// required membership role within the owning institution. Throws CompetitionError 404 if the
// competition does not exist; AccessError 403 if the membership requirement is not met.
// Reusable across all mutating competition routes.
export const assertCompetitionAccess = async (
  actorUserId: string,
  competitionId: string,
  requiredRole: CompetitionAccessLevel,
  db: Database = getDb(),
): Promise<CompetitionAccessResult> => {
  const competition = await loadCompetitionById(competitionId, db);
  if (!competition) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }

  const role = await findActiveMembershipRole(actorUserId, competition.institutionId, db);
  if (!role || !MEMBER_ROLES.includes(role)) {
    throw new AccessError("forbidden", 403, "Institution owner/staff access required");
  }
  if (requiredRole === "admin" && role !== "institution_owner") {
    throw new AccessError("forbidden", 403, "institution_owner access required");
  }

  return { competition, membershipRole: role };
};

// Read-only access. Permits platform_ops to read any competition without institution
// membership. Otherwise requires active membership (admin or staff) in the owning institution.
// Used by GET /api/v1/competitions/[competitionId].
export const assertCompetitionRead = async (
  actorUserId: string,
  actorRole: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<CompetitionAccessResult> => {
  const competition = await loadCompetitionById(competitionId, db);
  if (!competition) {
    throw new CompetitionError("competition_not_found", 404, "Competition not found");
  }

  if (actorRole === "platform_ops") {
    return { competition, membershipRole: null };
  }

  const role = await findActiveMembershipRole(actorUserId, competition.institutionId, db);
  if (!role || !MEMBER_ROLES.includes(role)) {
    throw new AccessError("forbidden", 403, "Institution owner/staff access required");
  }

  return { competition, membershipRole: role };
};

// Asserts that the institution's verification_status is "verified". Used by the publish
// transition guard. Throws CompetitionError 422 with code competition_institution_not_verified
// when the institution is not yet verified.
export const assertInstitutionVerified = async (
  institutionId: string,
  db: Database = getDb(),
): Promise<{ verificationStatus: InstitutionVerificationStatus }> => {
  const [row] = await db
    .select({ verificationStatus: institutions.verificationStatus })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);

  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Institution not found");
  }
  if (row.verificationStatus !== "verified") {
    throw new CompetitionError(
      "competition_institution_not_verified",
      422,
      "Institution must be verified by platform ops before publishing competitions",
    );
  }
  return row;
};

// Stub guard — registrations are not implemented until Phase 4. Always returns false.
// The transition logic (published → draft) calls this so the wiring exists when registration
// data ships. When that happens, replace the body with a real query against the registrations
// table and return true if any active registration exists for the given competition.
export const hasActiveRegistrationsForCompetition = async (
  _competitionId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  void db;
  return false;
};
