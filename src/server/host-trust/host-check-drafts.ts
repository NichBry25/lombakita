import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { MEMBER_ROLES } from "@/server/competitions/competition-access";
import type { Database } from "@/server/db/client";
import {
  competitions,
  institutionMemberships,
  recruiterVerificationSubmissions,
} from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/host-check-drafts");

export const GONE_DRAFT_CLOSE_REASON = "Ditutup karena draf tidak lagi tersedia.";

// A draft that a host check can still publish: not deleted and still a draft.
export const isLiveDraft: SQL = and(
  isNull(competitions.deletedAt),
  eq(competitions.status, "draft"),
)!;

// The live draft a host check names, for an EXISTS inside a statement on host check rows.
export const liveDraftOfCheck = (db: Database) =>
  db
    .select({ id: competitions.id })
    .from(competitions)
    .where(and(eq(competitions.id, recruiterVerificationSubmissions.competitionId), isLiveDraft));

// A join condition on institution_memberships: the user runs the competition's institution as an
// active owner or staff. A person who left a workspace, or was moved down to member, reads none of
// its drafts through it.
export const runsInstitutionOfCompetition = (userId: string): SQL =>
  and(
    eq(institutionMemberships.institutionId, competitions.institutionId),
    eq(institutionMemberships.userId, userId),
    eq(institutionMemberships.status, "active"),
    inArray(institutionMemberships.membershipRole, MEMBER_ROLES),
  )!;
