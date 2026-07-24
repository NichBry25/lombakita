import { and, count, eq, ne, sql, type SQL } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { enqueueCompetitionSearchSync } from "@/server/async/enqueue";
import { logger } from "@/lib/logger";
import {
  FULL_INSTITUTION_CREATION_MIN_TIER,
  getRecruiterTierForAccount,
  meetsRecruiterTier,
} from "@/server/auth/recruiter-tier";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  institutionMemberships,
  institutionSocialLinks,
  institutions,
  users,
  type InstitutionType,
} from "@/server/db/schema";
import {
  parseInstitutionProfileInput,
  InstitutionProfileInputError,
  type InstitutionSocialPlatform,
} from "@/server/institution-workspace/institution-profile-core";
import { isR2Available, generatePresignedPutUrl } from "@/server/storage/r2.client";
import {
  InstitutionWorkspaceInputError,
  MAX_INSTITUTIONS_PER_RECRUITER,
  buildInstitutionSlugCandidate,
  deriveInstitutionSlugBase,
  normalizeInstitutionSlug,
  parseInstitutionDisplayName,
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
import { acquireOwnerCapLock } from "@/server/institution-workspace/owner-cap-lock";

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
  institutionType: InstitutionType;
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
      { displayName: row.institutionDisplayName, institutionType: row.institutionType },
      { username: ownerUsername },
    ),
    slug: row.institutionSlug,
    status: row.institutionStatus,
    institutionType: row.institutionType,
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
    .where(and(eq(institutionMemberships.userId, userId), eq(institutions.slug, institutionSlug)))
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

// "is full/standard" SQL predicate: anything that is not personal. institution_type is NOT NULL,
// so a plain inequality is exact. The mirror of eq(institutions.institutionType,
// PERSONAL_INSTITUTION_TYPE) used for the "is personal" probe.
const FULL_INSTITUTION_TYPE_CONDITION = ne(institutions.institutionType, PERSONAL_INSTITUTION_TYPE);

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

// The 409 a caller sees when the full-institution cap is reached. Built in one place so the fast
// app-layer pre-check and the in-transaction re-check behind the owner lock throw a byte-identical
// error — a caller cannot tell which guard tripped.
const buildFullInstitutionLimitError = (): InstitutionWorkspaceInputError =>
  new InstitutionWorkspaceInputError(
    "recruiter_institution_limit_reached",
    `Recruiter may own at most ${MAX_INSTITUTIONS_PER_RECRUITER} institutions`,
    undefined,
    409,
  );

// The 409 a caller sees when the one-personal-per-recruiter cap is reached. Same pre-check /
// in-transaction parity as the full-institution error above.
const buildPersonalInstitutionLimitError = (): InstitutionWorkspaceInputError =>
  new InstitutionWorkspaceInputError(
    "personal_institution_already_exists",
    "You already have a personal institution. Only one is allowed per account.",
    undefined,
    409,
  );

// The owner-cap re-check applied INSIDE the insert transaction, behind acquireOwnerCapLock — the true
// guard against a concurrent same-owner create slipping past the fast pre-check. `typeCondition` and
// `max` reproduce the exact semantics of the caller's pre-check (full excludes personal via
// FULL_INSTITUTION_TYPE_CONDITION; personal counts only institution_type = 'personal'), and
// `buildLimitError` returns the same 409 the pre-check throws.
type OwnerCapGuard = {
  typeCondition: SQL | undefined;
  max: number;
  buildLimitError: () => InstitutionWorkspaceInputError;
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
  institutionType: InstitutionType,
  capGuard: OwnerCapGuard,
  db: Database,
): Promise<InstitutionWorkspaceShell> => {
  const baseSlug = params.explicitSlug ?? deriveInstitutionSlugBase(params.slugBaseSource);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = buildInstitutionSlugCandidate(baseSlug, attempt);

    // Flat-namespace guard (Fix C extended to the suffixed candidate). createInstitutionWorkspaceForUser
    // already checked the BASE slug against usernames; this re-checks each SUFFIXED candidate the slug
    // collision retry produces (e.g. a username `acme_2` would occupy slug `acme-2`). Bump the suffix on a
    // username collision so the loop converges on a slug clear of both institutions.slug AND users.username.
    // Skipped on the personal path: a personal slug derives from the owner's OWN username and would always
    // match itself. Exhaustion falls through to the shared "slug is not available" throw below.
    if (
      !isPersonalInstitutionType(institutionType) &&
      (await institutionSlugCollidesWithUsername(candidateSlug, db))
    ) {
      continue;
    }

    try {
      return await db.transaction(async (tx) => {
        // Serialize same-owner cap-guarded mutations, then re-count the owner's qualifying
        // institutions UNDER the lock: this is the true cap guard. A plain count (in or out of the
        // transaction) cannot see a concurrent same-owner insert under READ COMMITTED — see
        // acquireOwnerCapLock. The fast pre-check in the caller stays as the friendly-409 path.
        await acquireOwnerCapLock(tx, userId);

        const ownedCount = await countOwnedInstitutionsWhere(userId, capGuard.typeCondition, tx);
        if (ownedCount >= capGuard.max) {
          throw capGuard.buildLimitError();
        }

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
// full slot. The created row's institution_type is the subtype chosen on the create form
// (company | foundation | university | campus_organization) — never undeclared.
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
    throw buildFullInstitutionLimitError();
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
    input.institutionType,
    {
      typeCondition: FULL_INSTITUTION_TYPE_CONDITION,
      max: MAX_INSTITUTIONS_PER_RECRUITER,
      buildLimitError: buildFullInstitutionLimitError,
    },
    db,
  );
};

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
    throw buildPersonalInstitutionLimitError();
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
    {
      typeCondition: eq(institutions.institutionType, PERSONAL_INSTITUTION_TYPE),
      max: MAX_PERSONAL_INSTITUTIONS_PER_RECRUITER,
      buildLimitError: buildPersonalInstitutionLimitError,
    },
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

  const [row] = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(condition)
    .limit(1);

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
    .where(
      and(eq(competitions.institutionId, institutionId), eq(competitions.status, "published")),
    );

  return publishedRows.map((row) => row.id);
};

export type InstitutionUpgradeErrorCode =
  | "institution_not_found"
  | "institution_upgrade_forbidden"
  | "institution_upgrade_tier_insufficient"
  | "institution_upgrade_limit_reached"
  | "institution_upgrade_conflict"
  | "institution_upgrade_slug_unavailable";

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
  displayName: string;
  slug: string;
  previousSlug: string;
  resyncCompetitionIds: string[];
};

// Resolves a free institution slug for `institutionId` derived from `baseSlug`, excluding the row
// itself. Collisions are resolved by query rather than insert-and-catch: this runs inside a
// caller-owned transaction, where a failed statement aborts the whole transaction instead of
// allowing a retry (the same constraint rewritePersonalInstitutionSlugForUsername works under).
// Each candidate is also checked against users.username — institution slugs and usernames share one
// flat namespace. The institutions_slug_unique_idx remains the final backstop: a concurrent grab of
// the chosen slug fails the UPDATE and rolls the caller's transaction back.
const resolveFreeInstitutionSlug = async (
  baseSlug: string,
  institutionId: string,
  tx: DbOrTx,
): Promise<string | null> => {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = buildInstitutionSlugCandidate(baseSlug, attempt);

    const [taken] = await tx
      .select({ id: institutions.id })
      .from(institutions)
      .where(and(eq(institutions.slug, candidate), ne(institutions.id, institutionId)))
      .limit(1);

    if (taken) {
      continue;
    }

    if (await institutionSlugCollidesWithUsername(candidate, tx)) {
      continue;
    }

    return candidate;
  }

  return null;
};

// One-directional personal→full (or legacy-NULL→full) type upgrade, owner-initiated and
// self-service. The upgrade is a declaration, not a review: it flips the type immediately and
// leaves the institution unverified, because document verification is a separate, credibility-only
// system that no longer gates publishing (publishing gates on the account-level Trusted Recruiter
// status instead). In a single transaction it:
//   1. serializes same-owner cap-guarded mutations (acquireOwnerCapLock) BEFORE any count,
//   2. asserts the actor holds the elevated recruiter tier (FULL_INSTITUTION_CREATION_MIN_TIER),
//   3. asserts the actor is an active institution_owner of the target institution,
//   4. runs the fail-closed type-transition guard (assertInstitutionTypeTransition),
//   5. re-checks the recruiter's full-institution count INCLUDING the about-to-become-full
//      institution against MAX_INSTITUTIONS_PER_RECRUITER,
//   6. re-derives the slug from the official name, freeing the owner-username slug the personal
//      institution held,
//   7. atomically writes type + display_name + slug with a compare-and-set on the snapshot type.
//
// display_name is written in the same statement as the type flip because
// institutions_display_name_type_chk requires a non-null display_name for every non-personal row —
// flipping the type without it violates the CHECK constraint.
//
// The personal reach caps are derived live from institution_type, so the flip IS the cap release;
// there is no separate stored cap to clear. Returns the ids of the institution's published
// competitions so the caller can re-sync their cached institutionSlug in the search index.
export const upgradeInstitutionType = async (
  actorUserId: string,
  institutionId: string,
  nextType: FullInstitutionType,
  displayNameInput: unknown,
  db: Database = getDb(),
): Promise<UpgradeInstitutionTypeResult> => {
  const displayName = parseInstitutionDisplayName(displayNameInput);

  return db.transaction(async (tx) => {
    // 1. Serialize same-owner cap-guarded mutations before counting. The count below ranges over the
    // owner's OTHER institution rows, so gating the UPDATE on the target row alone cannot fence it:
    // two concurrent upgrades for the same owner would each snapshot a count blind to the other's
    // uncommitted flip and both pass the cap. See acquireOwnerCapLock.
    await acquireOwnerCapLock(tx, actorUserId);

    // 2. Elevated recruiter tier required.
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

    // 3. Load the institution and confirm the actor is an active institution_owner of it.
    const [row] = await tx
      .select({
        institutionType: institutions.institutionType,
        slug: institutions.slug,
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

    // 4. Fail-closed transition guard (throws InstitutionTypeTransitionError on any illegal pair).
    assertInstitutionTypeTransition(currentType, nextType);

    // 5. Limit re-check INCLUDING the upgrading institution: count existing full institutions the
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

    // 6. Re-derive the slug from the official name. A personal institution's slug is its owner's
    // username; carrying that onto a named institution would squat the owner's own namespace
    // permanently and force any replacement personal institution onto a `<username>-2` slug.
    const resolvedSlug = await resolveFreeInstitutionSlug(
      deriveInstitutionSlugBase(displayName),
      institutionId,
      tx,
    );
    if (resolvedSlug === null) {
      throw new InstitutionUpgradeError(
        "institution_upgrade_slug_unavailable",
        409,
        "No available URL could be derived from this institution name. Try a different name",
      );
    }

    // 7. Atomic write with a compare-and-set on the snapshot type (guards against a concurrent type
    // change between the read above and this write). verification_status resets to the unverified
    // default: the upgraded institution is a different entity from the personal one and has had no
    // documents reviewed under its new type. currentType is never null (institution_type is NOT NULL).
    const [updated] = await tx
      .update(institutions)
      .set({
        institutionType: nextType,
        displayName,
        slug: resolvedSlug,
        verificationStatus: "pending_verification",
        verifiedAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(institutions.id, institutionId), eq(institutions.institutionType, currentType)))
      .returning({ institutionId: institutions.id });

    if (!updated) {
      throw new InstitutionUpgradeError(
        "institution_upgrade_conflict",
        409,
        "Institution type was modified concurrently — reload and retry the upgrade",
      );
    }

    const publishedRows = await tx
      .select({ id: competitions.id })
      .from(competitions)
      .where(
        and(eq(competitions.institutionId, institutionId), eq(competitions.status, "published")),
      );

    return {
      institutionId: updated.institutionId,
      previousType: currentType,
      institutionType: nextType,
      displayName,
      slug: resolvedSlug,
      previousSlug: row.slug,
      resyncCompetitionIds: publishedRows.map((competition) => competition.id),
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

  // Flat-namespace guard (Fix C extended to the slug-change path): a full institution's new slug must
  // not collide with an existing user's username. No exclusion carve-out — renaming this institution
  // moves no existing name onto a user, so any username match is a real conflict. Unreachable on the
  // personal path (slug is never patched there). Sits alongside the reserved-word check (in parseSlug)
  // and the institutions.slug uniqueness retry (the catch below); order among the three is functional-only.
  if (updates.slug !== undefined && (await institutionSlugCollidesWithUsername(updates.slug, db))) {
    throw new InstitutionWorkspaceInputError(
      "institution_slug_conflicts_with_username",
      "This slug is already used as another user's username and cannot be used for an institution",
      { fields: ["slug"] },
      409,
    );
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

// ── Organizer public profile (about / contact / website / socials) ────────────
// Isolated from the workspace-identity shell above (name/slug/type). Owner-gated through the same
// findInstitutionWorkspaceByOwnerAndSlug gate. Personal institutions are lightweight and do not
// carry a public organizer profile — reads report isEditable=false and writes are refused.

export type InstitutionProfileView = {
  about: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  hasLogo: boolean;
  socialLinks: Array<{ platform: InstitutionSocialPlatform; url: string }>;
  isEditable: boolean;
};

export const getInstitutionProfileForOwnerBySlug = async (
  userId: string,
  institutionSlug: string,
  db: Database = getDb(),
): Promise<InstitutionProfileView> => {
  const normalizedSlug = parseInstitutionSlugParam(institutionSlug);
  const current = await findInstitutionWorkspaceByOwnerAndSlug(userId, normalizedSlug, db);
  if (!current) {
    throw await buildInstitutionWorkspaceAccessDeniedError(userId, normalizedSlug, db);
  }

  const [row] = await db
    .select({
      about: institutions.about,
      contactName: institutions.contactName,
      contactEmail: institutions.contactEmail,
      contactPhone: institutions.contactPhone,
      websiteUrl: institutions.websiteUrl,
      logoR2Key: institutions.logoR2Key,
    })
    .from(institutions)
    .where(eq(institutions.id, current.institutionId));

  const links = await db
    .select({ platform: institutionSocialLinks.platform, url: institutionSocialLinks.url })
    .from(institutionSocialLinks)
    .where(eq(institutionSocialLinks.institutionId, current.institutionId));

  return {
    about: row?.about ?? null,
    contactName: row?.contactName ?? null,
    contactEmail: row?.contactEmail ?? null,
    contactPhone: row?.contactPhone ?? null,
    websiteUrl: row?.websiteUrl ?? null,
    hasLogo: Boolean(row?.logoR2Key),
    socialLinks: links,
    isEditable: !isPersonalInstitutionType(current.institutionType ?? null),
  };
};

export const updateInstitutionProfileForOwnerBySlug = async (
  userId: string,
  institutionSlug: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<InstitutionProfileView> => {
  const normalizedSlug = parseInstitutionSlugParam(institutionSlug);
  const input = parseInstitutionProfileInput(payload);
  const current = await findInstitutionWorkspaceByOwnerAndSlug(userId, normalizedSlug, db);
  if (!current) {
    throw await buildInstitutionWorkspaceAccessDeniedError(userId, normalizedSlug, db);
  }

  if (isPersonalInstitutionType(current.institutionType ?? null)) {
    throw new InstitutionProfileInputError(
      "institution_profile_not_editable",
      "A personal institution does not have a public organizer profile",
      undefined,
      403,
    );
  }

  const institutionId = current.institutionId;

  await db.transaction(async (tx) => {
    await tx
      .update(institutions)
      .set({
        about: input.about,
        contactName: input.contactName,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        websiteUrl: input.websiteUrl,
        updatedAt: sql`now()`,
      })
      .where(eq(institutions.id, institutionId));

    // Full replacement of the social-link set — delete then insert the validated links.
    await tx
      .delete(institutionSocialLinks)
      .where(eq(institutionSocialLinks.institutionId, institutionId));

    if (input.socialLinks.length > 0) {
      await tx.insert(institutionSocialLinks).values(
        input.socialLinks.map((link) => ({
          institutionId,
          platform: link.platform,
          url: link.url,
        })),
      );
    }
  });

  return getInstitutionProfileForOwnerBySlug(userId, normalizedSlug, db);
};

// Presigned-PUT logo upload for the owner's institution. Mirrors the recruiter-verification and
// submission upload pattern: verify ownership, mint a namespaced R2 key, presign the PUT, and store
// the key. Personal institutions carry no public profile and are refused. 503 when storage is
// unconfigured (mirrors isR2Available degradation elsewhere).
const LOGO_UPLOAD_URL_EXPIRY_SECONDS = 300;

export const generateInstitutionLogoUploadUrl = async (
  userId: string,
  institutionSlug: string,
  file: { contentType: string },
  db: Database = getDb(),
): Promise<{ uploadUrl: string }> => {
  const normalizedSlug = parseInstitutionSlugParam(institutionSlug);
  const current = await findInstitutionWorkspaceByOwnerAndSlug(userId, normalizedSlug, db);
  if (!current) {
    throw await buildInstitutionWorkspaceAccessDeniedError(userId, normalizedSlug, db);
  }

  if (isPersonalInstitutionType(current.institutionType ?? null)) {
    throw new InstitutionProfileInputError(
      "institution_profile_not_editable",
      "A personal institution does not have a public organizer profile",
      undefined,
      403,
    );
  }

  if (!isR2Available()) {
    throw new InstitutionProfileInputError(
      "institution_profile_storage_unavailable",
      "Logo storage is unavailable",
      undefined,
      503,
    );
  }

  const r2Key = `institution-logos/${current.institutionId}/${crypto.randomUUID()}`;
  const uploadUrl = await generatePresignedPutUrl(
    r2Key,
    file.contentType,
    LOGO_UPLOAD_URL_EXPIRY_SECONDS,
  );

  await db
    .update(institutions)
    .set({ logoR2Key: r2Key, updatedAt: sql`now()` })
    .where(eq(institutions.id, current.institutionId));

  return { uploadUrl };
};

// Slug-keyed entry point for the owner-initiated type upgrade. Resolves the slug to an id, delegates
// every guard to upgradeInstitutionType (which owns the lock, tier, ownership, transition, and cap
// checks), then re-syncs the search index for the institution's published competitions — their
// cached institutionSlug changed with the rename.
export const upgradeInstitutionTypeForOwnerBySlug = async (
  actorUserId: string,
  institutionSlug: string,
  nextType: FullInstitutionType,
  displayNameInput: unknown,
  db: Database = getDb(),
): Promise<UpgradeInstitutionTypeResult> => {
  const normalizedSlug = parseInstitutionSlugParam(institutionSlug);

  const [row] = await db
    .select({ institutionId: institutions.id })
    .from(institutions)
    .where(eq(institutions.slug, normalizedSlug))
    .limit(1);

  if (!row) {
    throw new InstitutionUpgradeError("institution_not_found", 404, "Institution not found");
  }

  const result = await upgradeInstitutionType(
    actorUserId,
    row.institutionId,
    nextType,
    displayNameInput,
    db,
  );

  // Fire-and-forget after commit: a failed enqueue must not fail the upgrade. The DB slug is already
  // correct and the index self-heals on the next sync.
  for (const competitionId of result.resyncCompetitionIds) {
    enqueueCompetitionSearchSync({ competitionId, action: "upsert" }).catch((err: unknown) => {
      logger.warn("institution.upgrade.search-sync.enqueue-failed", {
        competitionId,
        institutionId: result.institutionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return result;
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
