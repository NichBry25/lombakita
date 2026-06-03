import { and, count, eq, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import { institutionMemberships, institutions } from "@/server/db/schema";
import {
  InstitutionWorkspaceInputError,
  MAX_INSTITUTIONS_PER_RECRUITER,
  buildInstitutionSlugCandidate,
  deriveInstitutionSlugBase,
  parseInstitutionSlugParam,
  parseInstitutionWorkspaceCreateInput,
  parseInstitutionWorkspaceSettingsPatch,
  type InstitutionWorkspaceShell,
} from "@/server/institution-workspace/institution-core";

const MAX_SLUG_ATTEMPTS = 20;
const NEW_INSTITUTION_DEFAULT_STATUS = "inactive";
const OWNER_ROLE = "institution_owner";
const ACTIVE_MEMBERSHIP_STATUS = "active";

type InstitutionWorkspaceRow = {
  institutionId: string;
  institutionDisplayName: string;
  institutionSlug: string;
  institutionStatus: InstitutionWorkspaceShell["status"];
  institutionCreatedAt: Date;
  institutionUpdatedAt: Date;
  membershipId: string;
  membershipRole: InstitutionWorkspaceShell["ownerMembership"]["membershipRole"];
  membershipStatus: InstitutionWorkspaceShell["ownerMembership"]["membershipStatus"];
  membershipJoinedAt: Date;
};

const mapInstitutionWorkspace = (row: InstitutionWorkspaceRow): InstitutionWorkspaceShell => {
  return {
    institutionId: row.institutionId,
    displayName: row.institutionDisplayName,
    slug: row.institutionSlug,
    status: row.institutionStatus,
    ownerMembership: {
      membershipId: row.membershipId,
      membershipRole: row.membershipRole,
      membershipStatus: row.membershipStatus,
      joinedAt: row.membershipJoinedAt,
    },
    createdAt: row.institutionCreatedAt,
    updatedAt: row.institutionUpdatedAt,
  };
};

// Returns true when the user holds ANY active or invited membership for the
// institution identified by slug. Used to distinguish a non-owner who is a member
// (returns 403 "owner access required") from a recruiter who is unrelated to the
// institution (returns 403 "not part of this institution"). Non-existent slugs
// fall into the second bucket — this preserves the accepted info-hiding posture.
const hasAnyMembershipForInstitutionSlug = async (
  userId: string,
  institutionSlug: string,
  db: Database,
): Promise<boolean> => {
  const [row] = await db
    .select({ membershipId: institutionMemberships.id })
    .from(institutionMemberships)
    .innerJoin(institutions, eq(institutions.id, institutionMemberships.institutionId))
    .where(
      and(eq(institutionMemberships.userId, userId), eq(institutions.slug, institutionSlug)),
    )
    .limit(1);

  return Boolean(row);
};

const buildInstitutionWorkspaceAccessDeniedError = async (
  userId: string,
  institutionSlug: string,
  db: Database,
): Promise<AccessError> => {
  const member = await hasAnyMembershipForInstitutionSlug(userId, institutionSlug, db);

  return new AccessError(
    "forbidden",
    403,
    member
      ? "Institution owner access required"
      : "You are not part of this institution and cannot access its settings",
  );
};

const findInstitutionWorkspaceByOwnerAndSlug = async (
  userId: string,
  institutionSlug: string,
  db: Database,
): Promise<InstitutionWorkspaceRow | null> => {
  const [row] = await db
    .select({
      institutionId: institutions.id,
      institutionDisplayName: institutions.displayName,
      institutionSlug: institutions.slug,
      institutionStatus: institutions.status,
      institutionCreatedAt: institutions.createdAt,
      institutionUpdatedAt: institutions.updatedAt,
      membershipId: institutionMemberships.id,
      membershipRole: institutionMemberships.membershipRole,
      membershipStatus: institutionMemberships.status,
      membershipJoinedAt: institutionMemberships.joinedAt,
    })
    .from(institutions)
    .innerJoin(
      institutionMemberships,
      and(
        eq(institutionMemberships.institutionId, institutions.id),
        eq(institutionMemberships.userId, userId),
        eq(institutionMemberships.membershipRole, OWNER_ROLE),
        eq(institutionMemberships.status, ACTIVE_MEMBERSHIP_STATUS),
      ),
    )
    .where(eq(institutions.slug, institutionSlug))
    .limit(1);

  return row ?? null;
};

// Drizzle wraps the underlying postgres.js error: the outer object exposes `query`,
// `params`, and `cause`, while `code` / `constraint_name` / `detail` live on `cause`.
// We inspect both layers so the slug-collision retry loop catches the violation
// regardless of which driver/version is in use.
const isInstitutionSlugUniqueViolation = (error: unknown): boolean => {
  type PgErrorShape = {
    code?: string;
    constraint_name?: string;
    constraint?: string;
    detail?: string;
  };

  const matches = (candidate: PgErrorShape | undefined): boolean => {
    if (!candidate || candidate.code !== "23505") {
      return false;
    }

    if (
      candidate.constraint === "institutions_slug_unique_idx" ||
      candidate.constraint_name === "institutions_slug_unique_idx"
    ) {
      return true;
    }

    return candidate.detail?.toLowerCase().includes("(slug)") ?? false;
  };

  if (!error || typeof error !== "object") {
    return false;
  }

  const outer = error as PgErrorShape & { cause?: unknown };
  if (matches(outer)) {
    return true;
  }

  if (outer.cause && typeof outer.cause === "object") {
    return matches(outer.cause as PgErrorShape);
  }

  return false;
};

export const createInstitutionWorkspaceForUser = async (
  userId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<InstitutionWorkspaceShell> => {
  // F7 (Step 6.5b): count active institution_owner memberships for this recruiter. Scoped to
  // this user only — another recruiter at their limit is unaffected.
  const countRows = await db
    .select({ value: count() })
    .from(institutionMemberships)
    .where(
      and(
        eq(institutionMemberships.userId, userId),
        eq(institutionMemberships.membershipRole, OWNER_ROLE),
        eq(institutionMemberships.status, ACTIVE_MEMBERSHIP_STATUS),
      ),
    );
  const ownedCount = countRows[0]?.value ?? 0;

  if (ownedCount >= MAX_INSTITUTIONS_PER_RECRUITER) {
    throw new InstitutionWorkspaceInputError(
      "recruiter_institution_limit_reached",
      `Recruiter may own at most ${MAX_INSTITUTIONS_PER_RECRUITER} institutions`,
      undefined,
      409,
    );
  }

  const input = parseInstitutionWorkspaceCreateInput(payload);
  const baseSlug = input.slug ?? deriveInstitutionSlugBase(input.displayName);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = buildInstitutionSlugCandidate(baseSlug, attempt);

    try {
      return await db.transaction(async (tx) => {
        const [institutionRow] = await tx
          .insert(institutions)
          .values({
            displayName: input.displayName,
            slug: candidateSlug,
            status: NEW_INSTITUTION_DEFAULT_STATUS,
          })
          .returning({
            institutionId: institutions.id,
            institutionDisplayName: institutions.displayName,
            institutionSlug: institutions.slug,
            institutionStatus: institutions.status,
            institutionCreatedAt: institutions.createdAt,
            institutionUpdatedAt: institutions.updatedAt,
          });

        if (!institutionRow) {
          throw new Error("Failed to create institution record");
        }

        const [membershipRow] = await tx
          .insert(institutionMemberships)
          .values({
            institutionId: institutionRow.institutionId,
            userId,
            membershipRole: OWNER_ROLE,
            status: ACTIVE_MEMBERSHIP_STATUS,
          })
          .returning({
            membershipId: institutionMemberships.id,
            membershipRole: institutionMemberships.membershipRole,
            membershipStatus: institutionMemberships.status,
            membershipJoinedAt: institutionMemberships.joinedAt,
          });

        if (!membershipRow) {
          throw new Error("Failed to create institution owner membership");
        }

        return mapInstitutionWorkspace({
          ...institutionRow,
          ...membershipRow,
        });
      });
    } catch (error) {
      if (isInstitutionSlugUniqueViolation(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new InstitutionWorkspaceInputError(
    "institution_invalid_value",
    "slug is not available. Please try another slug",
    {
      fields: ["slug"],
    },
  );
};

export const getInstitutionWorkspaceForOwnerBySlug = async (
  userId: string,
  institutionSlug: string,
  db: Database = getDb(),
): Promise<InstitutionWorkspaceShell> => {
  const normalizedSlug = parseInstitutionSlugParam(institutionSlug);
  const row = await findInstitutionWorkspaceByOwnerAndSlug(userId, normalizedSlug, db);

  if (!row) {
    throw await buildInstitutionWorkspaceAccessDeniedError(userId, normalizedSlug, db);
  }

  return mapInstitutionWorkspace(row);
};

export const updateInstitutionWorkspaceForOwnerBySlug = async (
  userId: string,
  institutionSlug: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<InstitutionWorkspaceShell> => {
  const normalizedLookupSlug = parseInstitutionSlugParam(institutionSlug);
  const patch = parseInstitutionWorkspaceSettingsPatch(payload);
  const current = await findInstitutionWorkspaceByOwnerAndSlug(userId, normalizedLookupSlug, db);

  if (!current) {
    throw await buildInstitutionWorkspaceAccessDeniedError(userId, normalizedLookupSlug, db);
  }

  const updates: {
    displayName?: string;
    slug?: string;
    updatedAt?: ReturnType<typeof sql>;
  } = {};

  if (patch.displayName !== undefined && patch.displayName !== current.institutionDisplayName) {
    updates.displayName = patch.displayName;
  }

  if (patch.slug !== undefined && patch.slug !== current.institutionSlug) {
    updates.slug = patch.slug;
  }

  if (Object.keys(updates).length === 0) {
    return mapInstitutionWorkspace(current);
  }

  updates.updatedAt = sql`now()`;

  try {
    await db.update(institutions).set(updates).where(eq(institutions.id, current.institutionId));
  } catch (error) {
    if (isInstitutionSlugUniqueViolation(error)) {
      throw new InstitutionWorkspaceInputError(
        "institution_invalid_value",
        "slug is already used by another institution",
        {
          fields: ["slug"],
        },
      );
    }

    throw error;
  }

  const nextSlug = updates.slug ?? current.institutionSlug;
  const updated = await findInstitutionWorkspaceByOwnerAndSlug(userId, nextSlug, db);

  if (!updated) {
    throw new AccessError("forbidden", 403, "Institution owner access required");
  }

  return mapInstitutionWorkspace(updated);
};
