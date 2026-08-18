import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  institutionMemberships,
  institutions,
  users,
  type CompetitionCategory,
  type CompetitionMode,
  type CompetitionStatus,
  type InstitutionMembershipRole,
  type InstitutionType,
  type InstitutionVerificationStatus,
} from "@/server/db/schema";
import { meetsRecruiterTier, OPPORTUNITY_PUBLISH_MIN_TIER } from "@/server/auth/recruiter-tier";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { CompetitionError } from "@/server/competitions/competition-core";
import {
  isPersonalInstitutionType,
  MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL,
} from "@/server/institution-workspace/institution-type";

assertServerOnly("server/competitions/competition-access");

// Required-role contract for assertCompetitionAccess.
//   "member" — any active institution_owner or institution_staff in the owning institution
//   "admin"  — only active institution_owner in the owning institution
// institution_member is excluded: no operational access to competition surfaces.
// Mutating routes (PATCH fields, DELETE) require "member".
// Status transitions and publish/unpublish/archive require "admin".
export type CompetitionAccessLevel = "member" | "admin";

// Output projection for every public competition response. fee_amount, fee_currency, and
// is_featured are intentionally excluded — the fee fields are schema-present but API-blocked
// until payments activate in Phase 7, and is_featured is ops-managed rather than public. All
// select() / .returning() calls that flow into a route response must use this projection so
// deferred fields cannot leak.
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
  resultAnnouncementAt: competitions.resultAnnouncementAt,
  minimumParticipantEntries: competitions.minimumParticipantEntries,
  participantConfirmationAt: competitions.participantConfirmationAt,
  participationConfirmedAt: competitions.participationConfirmedAt,
  cancelledAt: competitions.cancelledAt,
  cancellationReason: competitions.cancellationReason,
  allowCancellation: competitions.allowCancellation,
  cancellationCutoffDays: competitions.cancellationCutoffDays,
  publishedAt: competitions.publishedAt,
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
  resultAnnouncementAt: Date | null;
  minimumParticipantEntries: number | null;
  participantConfirmationAt: Date | null;
  participationConfirmedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  allowCancellation: boolean;
  cancellationCutoffDays: number | null;
  publishedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CompetitionAccessResult = {
  competition: CompetitionRow;
  membershipRole: InstitutionMembershipRole | null; // null when actor is platform_ops read
};

// institution_member is excluded: the member role has no operational competition access.
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

// Recruiter trust gate for publishing. The acting account must hold the Trusted Recruiter tier
// (`elevated`); sandboxed recruiters (`minimal`) may draft but not publish. Reads the tier from
// the DB (not the JWT) so a fresh platform-ops approval takes effect on the next request.
// Throws CompetitionError 403 competition_recruiter_not_trusted otherwise.
export const assertActorIsTrustedRecruiter = async (
  actorUserId: string,
  db: Database = getDb(),
): Promise<void> => {
  const [row] = await db
    .select({ recruiterVerificationTier: users.recruiterVerificationTier })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);

  if (!row || !meetsRecruiterTier(row.recruiterVerificationTier, OPPORTUNITY_PUBLISH_MIN_TIER)) {
    throw new CompetitionError(
      "competition_recruiter_not_trusted",
      403,
      "Publishing requires a Trusted Recruiter account — complete recruiter verification first",
    );
  }
};

// THE CHARGING GATE (DEC-0158). Asserts that the institution's verification_status is "verified".
//
// Verification gates the right to CHARGE MONEY, never the right to publish. An unverified
// institution runs free competitions and publishes them normally; what it may not do is take
// payment. Publishing is gated separately by assertActorIsTrustedRecruiter, the account-level trust
// gate, which is why this is not on the generic publish path.
//
// Revocation is read live through this call rather than snapshotted, so an institution whose
// verification is withdrawn stops being able to enable charging immediately. That is a CREDIBILITY
// change, not an operational takedown (DEC-0118): its existing free competitions are untouched and
// still publishable, and an in-flight bukti transfer can still be verified so a candidate who has
// already sent real money is not stranded. Suspension is the takedown axis, enforced separately by
// assertInstitutionNotSuspended.
//
// THIS IS THE ONLY VERIFICATION CHECK for charging. Every caller — the fee-setting write path, the
// publish gate for an already-priced competition, and payment creation as the fail-closed backstop
// — routes through this one function. A second, lighter check written elsewhere would be a second
// answer to the same question, and the two would drift.
//
// Throws CompetitionError 422 competition_institution_not_verified.
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
      "Institusi harus terverifikasi sebelum dapat memungut biaya pendaftaran. Kompetisi gratis tetap dapat dipublikasikan.",
    );
  }
  return row;
};

// Operational suspension gate, parallel to assertInstitutionVerified. Throws
// CompetitionError 403 institution_suspended when the institution's suspended_at is non-null.
// Loads the row itself (mirrors assertInstitutionVerified) so it wires cleanly into both the
// create path (which has no verification call) and the publish path. Suspension is independent of
// verification_status: a verified institution may be suspended and is blocked here regardless.
export const assertInstitutionNotSuspended = async (
  institutionId: string,
  db: Database = getDb(),
): Promise<void> => {
  const [row] = await db
    .select({ suspendedAt: institutions.suspendedAt })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);

  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Institution not found");
  }
  if (row.suspendedAt) {
    throw new CompetitionError(
      "institution_suspended",
      403,
      "This institution has been suspended by platform ops",
    );
  }
};

// Reads the owning institution's type. Returns null for a legacy/undeclared full
// institution. Throws 404 if the institution does not exist. Shared by the personal reach-cap
// guards on the competition-create, draft-edit, and publish paths.
export const loadInstitutionTypeById = async (
  institutionId: string,
  db: Database = getDb(),
): Promise<InstitutionType | null> => {
  const [row] = await db
    .select({ institutionType: institutions.institutionType })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);

  if (!row) {
    throw new CompetitionError("competition_not_found", 404, "Institution not found");
  }
  return row.institutionType;
};

// A personal institution may only run individual-mode competitions. No-op for full
// or legacy (NULL-type) institutions. Wired into the competition-create and draft-edit paths so a
// team/both mode can never be persisted on a personal-owned competition.
export const assertPersonalInstitutionIndividualMode = async (
  institutionId: string,
  mode: CompetitionMode | null,
  db: Database = getDb(),
): Promise<void> => {
  const institutionType = await loadInstitutionTypeById(institutionId, db);
  if (!isPersonalInstitutionType(institutionType)) {
    return;
  }
  if (mode !== null && mode !== "individual") {
    throw new CompetitionError(
      "competition_personal_individual_only",
      422,
      "A personal institution can only run individual-mode competitions",
    );
  }
};

// Publish-time reach cap for a personal institution: at most
// MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL competitions in `published` status (drafts
// do not count). No-op for full or legacy institutions. The current competition is excluded from
// the count (it is still draft at this point). Also re-asserts individual-only as defense in depth.
// Paid competitions for personal institutions are a Phase 7 concern — fee fields are deferred
// (DEC-0022) so no paid-path guard is wired here yet.
//
// This cap is only reachable once a personal institution can publish at all, which requires its
// KTP verification to pass (verification_status → verified). Until then a personal institution
// sits at pending_verification and the publish path is already blocked upstream by
// assertInstitutionVerified.
export const assertPersonalCompetitionPublishable = async (
  competition: { id: string; institutionId: string; mode: CompetitionMode | null },
  db: Database = getDb(),
): Promise<void> => {
  const institutionType = await loadInstitutionTypeById(competition.institutionId, db);
  if (!isPersonalInstitutionType(institutionType)) {
    return;
  }

  if (competition.mode !== null && competition.mode !== "individual") {
    throw new CompetitionError(
      "competition_personal_individual_only",
      422,
      "A personal institution can only run individual-mode competitions",
    );
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(competitions)
    .where(
      and(
        eq(competitions.institutionId, competition.institutionId),
        eq(competitions.status, "published"),
        isNull(competitions.deletedAt),
        ne(competitions.id, competition.id),
      ),
    );

  if ((row?.count ?? 0) >= MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL) {
    throw new CompetitionError(
      "competition_personal_publish_limit",
      422,
      `A personal institution may have at most ${MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL} published competitions`,
    );
  }
};

// Guard for the published → draft unpublish transition.
// Counts any non-cancelled competition_registrations row for the given competition; individual
// and team registrations both write to this table, so no type discrimination is needed here.
export const hasActiveRegistrationsForCompetition = async (
  competitionId: string,
  db: Database | Parameters<Parameters<Database["transaction"]>[0]>[0] = getDb(),
): Promise<boolean> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        ne(competitionRegistrations.status, "cancelled"),
      ),
    );
  return (row?.count ?? 0) > 0;
};
