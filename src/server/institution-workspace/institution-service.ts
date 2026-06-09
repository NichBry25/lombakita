import { and, count, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import {
  FULL_INSTITUTION_CREATION_MIN_TIER,
  getRecruiterTierForAccount,
  meetsRecruiterTier,
} from "@/server/auth/recruiter-tier";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  institutionMemberships,
  institutions,
  users,
  type InstitutionType,
} from "@/server/db/schema";
import {
  InstitutionWorkspaceInputError,
  MAX_INSTITUTIONS_PER_RECRUITER,
  buildInstitutionSlugCandidate,
  deriveInstitutionSlugBase,
  normalizeInstitutionSlug,
  parseInstitutionSlugParam,
  parseInstitutionWorkspaceCreateInput,
  parseInstitutionWorkspaceSettingsPatch,
  type InstitutionWorkspaceShell,
} from "@/server/institution-workspace/institution-core";
import {
  assertInstitutionTypeTransition,
  isPersonalInstitutionType,
  MAX_PERSONAL_INSTITUTIONS_PER_RECRUITER,
  PERSONAL_INSTITUTION_TYPE,
  type FullInstitutionType,
} from "@/server/institution-workspace/institution-type";
import { getInstitutionDisplayName } from "@/server/institution-workspace/institution-display-name";

const MAX_SLUG_ATTEMPTS = 20;
const NEW_INSTITUTION_DEFAULT_STATUS = "inactive";
const OWNER_ROLE = "institution_owner";
const ACTIVE_MEMBERSHIP_STATUS = "active";

// Accepts either a top-level Database handle or a transaction handle, so slug-sync helpers can run
// inside a caller-owned transaction (the profile username-update path) or standalone.
type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

type InstitutionWorkspaceRow = {
  institutionId: string;
  // Nullable: NULL for a personal institution (no stored name). The shell's resolved displayName is
  // computed from this + the owner username via getInstitutionDisplayName.
  institutionDisplayName: string | null;
  institutionSlug: string;
  institutionStatus: InstitutionWorkspaceShell["status"];
  institutionType: InstitutionType | null;
  institutionCreatedAt: Date;
  institutionUpdatedAt: Date;
  membershipId: string;
  membershipRole: InstitutionWorkspaceShell["ownerMembership"]["membershipRole"];
  membershipStatus: InstitutionWorkspaceShell["ownerMembership"]["membershipStatus"];
  membershipJoinedAt: Date;
};

// The shell's displayName is the RESOLVED user-facing name: for a personal institution it derives
// from the owner username; for full/legacy it is the stored value. `ownerUsername` is the username
// of this institution's owner (the requester on owner-scoped reads; the loaded creator on create).
const mapInstitutionWorkspace = (
  row: InstitutionWorkspaceRow,
  ownerUsername: string | null,
): InstitutionWorkspaceShell => {
  return {
    institutionId: row.institutionId,
    displayName: getInstitutionDisplayName(
      { displayName: row.institutionDisplayName, institutionType: row.institutionType ?? null },
      { username: ownerUsername },
    ),
    slug: row.institutionSlug,
    status: row.institutionStatus,
    institutionType: row.institutionType ?? null,
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

// The requester is the institution_owner being matched, so users.username joined on the membership
// userId IS the owner username — exactly what getInstitutionDisplayName needs for a personal row.
type InstitutionWorkspaceOwnerRow = InstitutionWorkspaceRow & { ownerUsername: string | null };

const findInstitutionWorkspaceByOwnerAndSlug = async (
  userId: string,
  institutionSlug: string,
  db: Database,
): Promise<InstitutionWorkspaceOwnerRow | null> => {
  const [row] = await db
    .select({
      institutionId: institutions.id,
      institutionDisplayName: institutions.displayName,
      institutionSlug: institutions.slug,
      institutionStatus: institutions.status,
      institutionType: institutions.institutionType,
      institutionCreatedAt: institutions.createdAt,
      institutionUpdatedAt: institutions.updatedAt,
      membershipId: institutionMemberships.id,
      membershipRole: institutionMemberships.membershipRole,
      membershipStatus: institutionMemberships.status,
      membershipJoinedAt: institutionMemberships.joinedAt,
      ownerUsername: users.username,
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
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(eq(institutions.slug, institutionSlug))
    .limit(1);

  return row ?? null;
};

// Step 6.5f.1 — "is full/standard" SQL predicate: NULL counts as full (legacy undeclared), so it
// is `institution_type IS DISTINCT FROM 'personal'` expressed without raw SQL. The mirror of
// `eq(institutions.institutionType, PERSONAL_INSTITUTION_TYPE)` used for the "is personal" probe.
const FULL_INSTITUTION_TYPE_CONDITION = or(
  isNull(institutions.institutionType),
  ne(institutions.institutionType, PERSONAL_INSTITUTION_TYPE),
);

// Counts the institutions this user actively owns (active institution_owner membership), filtered
// by an extra institution-type condition. Single source of truth for every owner-scoped count:
//   full-institution limit  → FULL_INSTITUTION_TYPE_CONDITION (personal excluded)
//   one-personal-per-recruiter → eq(institutionType, 'personal')
//   upgrade limit re-check  → FULL_INSTITUTION_TYPE_CONDITION AND id <> upgrading-institution
const countOwnedInstitutionsWhere = async (
  userId: string,
  extraCondition: SQL | undefined,
  db: Database,
): Promise<number> => {
  const rows = await db
    .select({ value: count() })
    .from(institutionMemberships)
    .innerJoin(institutions, eq(institutions.id, institutionMemberships.institutionId))
    .where(
      and(
        eq(institutionMemberships.userId, userId),
        eq(institutionMemberships.membershipRole, OWNER_ROLE),
        eq(institutionMemberships.status, ACTIVE_MEMBERSHIP_STATUS),
        extraCondition,
      ),
    );
  return rows[0]?.value ?? 0;
};

// Slug-collision-retrying insert of an institution row plus its institution_owner membership, in a
// single transaction. Shared by the full and personal create paths. They differ in:
//   - displayName: a non-null name for full; NULL for personal (name derives from owner username).
//   - institutionType: null (legacy/undeclared full) vs "personal" (capped personal type).
//   - slugBase: the full path derives it from the display name (or an explicit user slug); the
//     personal path derives it from the owner username (no name or slug is supplied).
// `ownerUsername` is threaded only so the returned shell can resolve a personal institution's name.
type InsertInstitutionParams = {
  displayName: string | null;
  explicitSlug: string | null;
  slugBaseSource: string;
  ownerUsername: string | null;
};

const insertInstitutionWithOwner = async (
  userId: string,
  params: InsertInstitutionParams,
  institutionType: InstitutionType | null,
  db: Database,
): Promise<InstitutionWorkspaceShell> => {
  const baseSlug = params.explicitSlug ?? deriveInstitutionSlugBase(params.slugBaseSource);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = buildInstitutionSlugCandidate(baseSlug, attempt);

    try {
      return await db.transaction(async (tx) => {
        const [institutionRow] = await tx
          .insert(institutions)
          .values({
            displayName: params.displayName,
            slug: candidateSlug,
            status: NEW_INSTITUTION_DEFAULT_STATUS,
            institutionType,
          })
          .returning({
            institutionId: institutions.id,
            institutionDisplayName: institutions.displayName,
            institutionSlug: institutions.slug,
            institutionStatus: institutions.status,
            institutionType: institutions.institutionType,
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

        return mapInstitutionWorkspace(
          {
            ...institutionRow,
            ...membershipRow,
          },
          params.ownerUsername,
        );
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

// Full-institution creation. Step 6.5f.1: the recruiter-tier gate (now `elevated`) is enforced in
// the route layer via assertRecruiterTier; this service owns the per-recruiter limit. The limit
// count EXCLUDES personal-typed institutions (FULL_INSTITUTION_TYPE_CONDITION) — a recruiter at the
// full limit can still hold a personal institution, and a personal institution never consumes a
// full slot. The created row's institution_type is NULL (legacy/undeclared full); the concrete
// full subtype is declared later through the F10 flow (Step 6.5g).
export const createInstitutionWorkspaceForUser = async (
  userId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<InstitutionWorkspaceShell> => {
  // F7 (Step 6.5b): count active institution_owner memberships for this recruiter, excluding
  // personal-typed institutions (Step 6.5f.1). Scoped to this user only — another recruiter at
  // their limit is unaffected.
  const ownedCount = await countOwnedInstitutionsWhere(userId, FULL_INSTITUTION_TYPE_CONDITION, db);

  if (ownedCount >= MAX_INSTITUTIONS_PER_RECRUITER) {
    throw new InstitutionWorkspaceInputError(
      "recruiter_institution_limit_reached",
      `Recruiter may own at most ${MAX_INSTITUTIONS_PER_RECRUITER} institutions`,
      undefined,
      409,
    );
  }

  // Service-layer NOT NULL invariant (replaces the loosened DB constraint from migration 0031):
  // parseInstitutionWorkspaceCreateInput requires a 2–160 char displayName and throws
  // institution_invalid_value on a missing / empty / non-string value, so a full institution can
  // never be created without a stored display name.
  const input = parseInstitutionWorkspaceCreateInput(payload);

  // Flat-namespace guard (Fix C): the base slug this institution would take must not collide with an
  // existing user's username. The reserved-word check already ran inside parseInstitutionWorkspaceCreateInput
  // and the institutions.slug uniqueness check is the insert-time collision retry below; this is the
  // third namespace gate. The base slug is computed exactly as insertInstitutionWithOwner derives it
  // (explicit slug, else from the display name), so the value checked is the value that would land.
  const proposedBaseSlug = input.slug ?? deriveInstitutionSlugBase(input.displayName);
  if (await institutionSlugCollidesWithUsername(proposedBaseSlug, db)) {
    throw new InstitutionWorkspaceInputError(
      "institution_slug_conflicts_with_username",
      "This slug is already used as another user's username and cannot be used for an institution",
      { fields: ["slug"] },
      409,
    );
  }

  return insertInstitutionWithOwner(
    userId,
    {
      displayName: input.displayName,
      explicitSlug: input.slug,
      slugBaseSource: input.displayName,
      // Full institution: the stored display name is authoritative; the owner username is unused.
      ownerUsername: null,
    },
    null,
    db,
  );
}

// Loads the creator's current username — both the slug base and the read-time display name for a
// personal institution derive from it. Only ever called for an authenticated session user.
const loadOwnerUsername = async (userId: string, db: Database): Promise<string> => {
  const [row] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    throw new Error("Account not found while creating a personal institution");
  }
  return row.username;
};

// Step 6.5f.1 — lightweight personal institution creation. The recruiter-tier gate (now `minimal`)
// is enforced in the route layer; this service owns the one-personal-per-recruiter invariant. The
// created row is institution_type='personal' and the creator becomes its sole institution_owner.
// The personal reach caps (≤2 published competitions, individual-only, no featured, no staff/member
// invites) are enforced at the respective gates by reading institution_type — not stored here.
//
// There is NO name input: a personal institution stores display_name = NULL and its name derives
// from the owner username at read time. The slug also derives from the owner username through the
// shared slug-uniqueness / collision-suffix path, so the common case is /institution/<username>.
//
// A personal institution is created with verification_status = 'pending_verification' (the schema
// default, same as full). The personal verification gate is KTP-only at MVP and asynchronous; the
// KTP capture, submission surface, and review flow are built in Step 6.5g (F10). This step records
// the semantics only — it does not capture or review KTP.
export const createPersonalInstitutionForUser = async (
  userId: string,
  db: Database = getDb(),
): Promise<InstitutionWorkspaceShell> => {
  const personalCount = await countOwnedInstitutionsWhere(
    userId,
    eq(institutions.institutionType, PERSONAL_INSTITUTION_TYPE),
    db,
  );

  if (personalCount >= MAX_PERSONAL_INSTITUTIONS_PER_RECRUITER) {
    throw new InstitutionWorkspaceInputError(
      "personal_institution_already_exists",
      "You already have a personal institution. Only one is allowed per account.",
      undefined,
      409,
    );
  }

  const ownerUsername = await loadOwnerUsername(userId, db);

  return insertInstitutionWithOwner(
    userId,
    {
      displayName: null,
      explicitSlug: null,
      slugBaseSource: ownerUsername,
      ownerUsername,
    },
    PERSONAL_INSTITUTION_TYPE,
    db,
  );
};

// A personal institution's slug is derived from its owner's username, so a username change must
// rewrite the slug to keep /institution/<username>/... resolvable. Returns the personal institution
// the user actively owns (id + current slug), or null when the user has none — candidate accounts
// and recruiters without a personal institution have nothing to rewrite.
export const findOwnedPersonalInstitution = async (
  userId: string,
  db: DbOrTx = getDb(),
): Promise<{ institutionId: string; slug: string } | null> => {
  const [row] = await db
    .select({ institutionId: institutions.id, slug: institutions.slug })
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
    .where(eq(institutions.institutionType, PERSONAL_INSTITUTION_TYPE))
    .limit(1);

  return row ?? null;
};

// True when an institution OTHER than `excludeInstitutionId` already holds the slug a username would
// normalize to. The caller's own personal institution is excluded because it is the row that the
// rename will overwrite — it must not block itself. Backs the Fix-B username-change guard (no
// exclusion needed there beyond the actor's own personal institution).
export const usernameCollidesWithInstitutionSlug = async (
  newUsername: string,
  excludeInstitutionId: string | null,
  db: DbOrTx = getDb(),
): Promise<boolean> => {
  const candidateSlug = deriveInstitutionSlugBase(newUsername);
  const condition = excludeInstitutionId
    ? and(eq(institutions.slug, candidateSlug), ne(institutions.id, excludeInstitutionId))
    : eq(institutions.slug, candidateSlug);

  const [row] = await db.select({ id: institutions.id }).from(institutions).where(condition).limit(1);

  return Boolean(row);
};

// True when an existing user's username already occupies the flat-namespace slot a proposed
// institution slug would take. Usernames and institution slugs share one namespace. A username is
// stored lowercase over [a-z0-9_] — no hyphens, no diacritics — so the username→slug normalization
// is exactly `_`→`-`, making it a bijection: the one and only username that normalizes to a given
// slug is that slug with `-`→`_`. Converting the proposed slug back into username space and matching
// it against the indexed users.username column is therefore the apples-to-apples comparison the spec
// requires (and the index-friendly mirror of usernameCollidesWithInstitutionSlug, which converts in
// the other direction). Creating a new full institution moves no existing name, so there is no
// exclusion carve-out — any username match is a real conflict.
export const institutionSlugCollidesWithUsername = async (
  proposedSlug: string,
  db: DbOrTx = getDb(),
): Promise<boolean> => {
  const equivalentUsername = proposedSlug.replace(/-/g, "_");

  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, equivalentUsername))
    .limit(1);

  return Boolean(row);
};

// Rewrites a personal institution's slug to follow a new owner username, returning the ids of its
// published competitions so the caller can re-sync their cached institutionSlug in the search index.
// Reuses the same deriveInstitutionSlugBase + buildInstitutionSlugCandidate path as creation, but
// resolves collisions by query (not insert-and-catch): this runs inside a caller-owned transaction,
// where a failed statement would abort the whole transaction rather than allow a retry. The
// institutions_slug_unique_idx remains the final backstop — a concurrent grab of the chosen slug
// fails the UPDATE and rolls the caller's transaction back, leaving the username unchanged.
export const rewritePersonalInstitutionSlugForUsername = async (
  institutionId: string,
  newUsername: string,
  db: DbOrTx,
): Promise<string[]> => {
  const baseSlug = deriveInstitutionSlugBase(newUsername);

  let resolvedSlug: string | null = null;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = buildInstitutionSlugCandidate(baseSlug, attempt);
    const [taken] = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(and(eq(institutions.slug, candidate), ne(institutions.id, institutionId)))
      .limit(1);

    if (!taken) {
      resolvedSlug = candidate;
      break;
    }
  }

  if (resolvedSlug === null) {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_value",
      "slug is not available. Please try another slug",
      { fields: ["slug"] },
    );
  }

  await db
    .update(institutions)
    .set({ slug: resolvedSlug, updatedAt: sql`now()` })
    .where(eq(institutions.id, institutionId));

  const publishedRows = await db
    .select({ id: competitions.id })
    .from(competitions)
    .where(and(eq(competitions.institutionId, institutionId), eq(competitions.status, "published")));

  return publishedRows.map((row) => row.id);
};

export type InstitutionUpgradeErrorCode =
  | "institution_not_found"
  | "institution_upgrade_forbidden"
  | "institution_upgrade_tier_insufficient"
  | "institution_upgrade_limit_reached"
  | "institution_upgrade_conflict";

export class InstitutionUpgradeError extends Error {
  constructor(
    public readonly code: InstitutionUpgradeErrorCode,
    public readonly status: 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "InstitutionUpgradeError";
  }
}

export type UpgradeInstitutionTypeResult = {
  institutionId: string;
  previousType: InstitutionType | null;
  institutionType: FullInstitutionType;
};

// Step 6.5f.1 — one-directional personal→full (or legacy-NULL→full) type-upgrade primitive.
//
// NO LIVE CALLER in this step by design: the F10 approval handler (Step 6.5g) is the intended
// caller. The primitive exists now because the institution_type column needs a guarded mutation
// path the moment it exists. In a single transaction it:
//   1. asserts the actor holds the elevated recruiter tier (FULL_INSTITUTION_CREATION_MIN_TIER),
//   2. asserts the actor is an active institution_owner of the target institution,
//   3. runs the fail-closed type-transition guard (assertInstitutionTypeTransition),
//   4. re-checks the recruiter's full-institution count INCLUDING the about-to-become-full
//      institution against MAX_INSTITUTIONS_PER_RECRUITER,
//   5. atomically flips institution_type with a compare-and-set on the snapshot type. The personal
//      reach caps are derived live from institution_type, so the single flip IS the cap release —
//      there is no separate stored cap to clear.
export const upgradeInstitutionType = async (
  actorUserId: string,
  institutionId: string,
  nextType: FullInstitutionType,
  db: Database = getDb(),
): Promise<UpgradeInstitutionTypeResult> => {
  return db.transaction(async (tx) => {
    // 1. Elevated recruiter tier required.
    const tierState = await getRecruiterTierForAccount(actorUserId, tx);
    if (
      !tierState ||
      !tierState.recruiterVerified ||
      !meetsRecruiterTier(tierState.recruiterVerificationTier, FULL_INSTITUTION_CREATION_MIN_TIER)
    ) {
      throw new InstitutionUpgradeError(
        "institution_upgrade_tier_insufficient",
        403,
        `Upgrading an institution requires the '${FULL_INSTITUTION_CREATION_MIN_TIER}' recruiter tier`,
      );
    }

    // 2. Load the institution and confirm the actor is an active institution_owner of it.
    const [row] = await tx
      .select({
        institutionType: institutions.institutionType,
        ownerMembershipId: institutionMemberships.id,
      })
      .from(institutions)
      .leftJoin(
        institutionMemberships,
        and(
          eq(institutionMemberships.institutionId, institutions.id),
          eq(institutionMemberships.userId, actorUserId),
          eq(institutionMemberships.membershipRole, OWNER_ROLE),
          eq(institutionMemberships.status, ACTIVE_MEMBERSHIP_STATUS),
        ),
      )
      .where(eq(institutions.id, institutionId))
      .limit(1);

    if (!row) {
      throw new InstitutionUpgradeError("institution_not_found", 404, "Institution not found");
    }
    if (!row.ownerMembershipId) {
      throw new InstitutionUpgradeError(
        "institution_upgrade_forbidden",
        403,
        "Active institution_owner access is required to upgrade this institution",
      );
    }

    const currentType = row.institutionType;

    // 3. Fail-closed transition guard (throws InstitutionTypeTransitionError on any illegal pair).
    assertInstitutionTypeTransition(currentType, nextType);

    // 4. Limit re-check INCLUDING the upgrading institution: count existing full institutions the
    // actor owns EXCLUDING this one; adding this one back must not exceed the limit.
    const existingFullCount = await countOwnedInstitutionsWhere(
      actorUserId,
      and(FULL_INSTITUTION_TYPE_CONDITION, ne(institutions.id, institutionId)),
      tx,
    );
    if (existingFullCount + 1 > MAX_INSTITUTIONS_PER_RECRUITER) {
      throw new InstitutionUpgradeError(
        "institution_upgrade_limit_reached",
        409,
        `Upgrading would exceed the limit of ${MAX_INSTITUTIONS_PER_RECRUITER} full institutions`,
      );
    }

    // 5. Atomic flip with CAS on the snapshot type (guards against a concurrent type change between
    // the read above and this write).
    const typeCas =
      currentType === null
        ? isNull(institutions.institutionType)
        : eq(institutions.institutionType, currentType);

    const [updated] = await tx
      .update(institutions)
      .set({ institutionType: nextType, updatedAt: sql`now()` })
      .where(and(eq(institutions.id, institutionId), typeCas))
      .returning({ institutionId: institutions.id });

    if (!updated) {
      throw new InstitutionUpgradeError(
        "institution_upgrade_conflict",
        409,
        "Institution type was modified concurrently — reload and retry the upgrade",
      );
    }

    return {
      institutionId: updated.institutionId,
      previousType: currentType,
      institutionType: nextType,
    };
  });
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

  return mapInstitutionWorkspace(row, row.ownerUsername);
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

  // A personal institution stores no display name and its slug derives from the owner username, so
  // neither a displayName nor a slug patch is persisted on the personal path — both fields are
  // read-only there (the slug changes only when the username changes). The settings UI renders both
  // read-only as well; this is the authoritative server-side enforcement.
  const isPersonal = isPersonalInstitutionType(current.institutionType ?? null);

  const updates: {
    displayName?: string;
    slug?: string;
    updatedAt?: ReturnType<typeof sql>;
  } = {};

  if (
    !isPersonal &&
    patch.displayName !== undefined &&
    patch.displayName !== current.institutionDisplayName
  ) {
    updates.displayName = patch.displayName;
  }

  if (!isPersonal && patch.slug !== undefined && patch.slug !== current.institutionSlug) {
    updates.slug = patch.slug;
  }

  if (Object.keys(updates).length === 0) {
    return mapInstitutionWorkspace(current, current.ownerUsername);
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

  return mapInstitutionWorkspace(updated, updated.ownerUsername);
};

// Step 6.5f.1 (Amendment) — resolve an institution's type by slug for owner-or-staff UI surfaces
// that decide whether to hide personal-only affordances (the competition mode selector and the
// staff-invite form). Returns null for a full/legacy institution or a slug that does not resolve;
// callers treat null as "not personal" and fall back to the full UI. Server-side guards remain the
// authoritative enforcement; this only drives the affordance hide.
export const loadInstitutionTypeBySlug = async (
  institutionSlug: string,
  db: Database = getDb(),
): Promise<InstitutionType | null> => {
  const normalized = normalizeInstitutionSlug(institutionSlug);
  const [row] = await db
    .select({ institutionType: institutions.institutionType })
    .from(institutions)
    .where(eq(institutions.slug, normalized))
    .limit(1);
  return row?.institutionType ?? null;
};
