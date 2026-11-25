import { and, count, eq, inArray, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionMemberships,
  institutionSocialLinks,
  institutions,
  users,
  type InstitutionType,
  type InstitutionVerificationStatus,
} from "@/server/db/schema";
import {
  parseInstitutionProfileInput,
  InstitutionProfileInputError,
  type InstitutionSocialPlatform,
} from "@/server/institution-workspace/institution-profile-core";
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
  isPersonalInstitutionType,
  PERSONAL_INSTITUTION_TYPE,
} from "@/server/institution-workspace/institution-type";
import {
  getInstitutionDisplayName,
  institutionOwnerUsernameSql,
} from "@/server/institution-workspace/institution-display-name";
import {
  institutionOwnerAvatarKeySql,
  institutionOwnerBannerKeySql,
} from "@/server/institution-workspace/institution-media";
import { resolveInstitutionMediaUrls } from "@/server/institution-workspace/institution-media-urls";
import { acquireOwnerCapLock } from "@/server/institution-workspace/owner-cap-lock";
import { assertAccountNotDeactivated } from "@/server/accounts/deactivated-account";
import { isHostTrustRemoved } from "@/server/host-trust/publish-trust";

// `assertAccountNotDeactivated` throws the shape every refusal class in the repository carries —
// (code, status, message) — and this module's own error takes its status last, so that class cannot
// be handed to it as it stands. This is that shape and nothing else: what it constructs is still an
// `InstitutionWorkspaceInputError`, so the create route's `instanceof` branch and the envelope it
// builds are the ones this module already had.
class InstitutionDeactivatedError extends InstitutionWorkspaceInputError {
  constructor(code: "account_deactivated", status: 409, message: string) {
    super(code, message, undefined, status);
  }
}

const MAX_SLUG_ATTEMPTS = 20;
/**
 * The `institutions.status` every created institution carries.
 *
 * Exported so a test fixture can write the value production writes rather than the column's schema
 * default, which is `active` and which no institution this service creates has ever held. A fixture
 * that inserts directly and takes the default is describing a row shape that does not exist: a
 * change filtering on `status = 'active'` would empty a public read in production while every test
 * seeded through the default stayed green.
 */
export const NEW_INSTITUTION_DEFAULT_STATUS = "inactive";
const OWNER_ROLE = "institution_owner";
const STAFF_ROLE = "institution_staff";
const ACTIVE_MEMBERSHIP_STATUS = "active";

// Accepts either a top-level Database handle or a transaction handle, so a lookup or the username
// check can run inside a caller-owned transaction (the profile save) or standalone.
type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

type InstitutionWorkspaceRow = {
  institutionId: string;
  // Nullable: a personal institution may store no name. The shell's resolved name comes from
  // getInstitutionDisplayName.
  institutionDisplayName: string | null;
  institutionSlug: string;
  institutionStatus: InstitutionWorkspaceShell["status"];
  institutionType: InstitutionType;
  institutionDescription: string | null;
  institutionCreatedAt: Date;
  institutionUpdatedAt: Date;
  membershipId: string;
  membershipRole: InstitutionWorkspaceShell["ownerMembership"]["membershipRole"];
  membershipStatus: InstitutionWorkspaceShell["ownerMembership"]["membershipStatus"];
  membershipJoinedAt: Date;
};

// The shell's displayName is the RESOLVED user-facing name (getInstitutionDisplayName): the stored
// name, or for a personal institution that stores none, a name derived from `ownerUsername`, the
// username of this institution's owner on owner-scoped reads.
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
    description: row.institutionDescription,
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

export const buildInstitutionWorkspaceAccessDeniedError = async (
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

export const findInstitutionWorkspaceByOwnerAndSlug = async (
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
      institutionDescription: institutions.description,
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

export type UserInstitutionMembership = {
  institutionId: string;
  slug: string;
  displayName: string;
  // The public organizer bio (full institutions only), or null when unset.
  about: string | null;
  // The legacy internal description. Retained only as the dashboard-card fallback for institutions
  // that have no `about` — personal institutions, which carry no public organizer profile, and
  // full institutions that have not written one yet.
  description: string | null;
  role: typeof OWNER_ROLE | typeof STAFF_ROLE;
  isOwner: boolean;
  // Count of the institution's active operational members (owner + staff), so the dashboard can show
  // team size. institution_member is excluded — cosmetic-at-launch, no operational surface.
  staffCount: number;
  // Presigned display URLs, null when nothing is stored or R2 is unavailable. A personal institution
  // resolves to its owner's avatar and banner (resolveInstitutionMediaKeys).
  logoUrl: string | null;
  bannerUrl: string | null;
};

// Lists the institutions an account actively participates in as owner or staff, for the recruiter
// dashboard. institution_member memberships are excluded (members have no operational
// surface). A personal institution stores no display name; the owner username resolves it through
// getInstitutionDisplayName, sourced from the correlated owner-username subquery.
export const listUserInstitutionMemberships = async (
  userId: string,
  db: Database = getDb(),
): Promise<UserInstitutionMembership[]> => {
  const rows = await db
    .select({
      institutionId: institutions.id,
      slug: institutions.slug,
      displayName: institutions.displayName,
      institutionType: institutions.institutionType,
      about: institutions.about,
      description: institutions.description,
      membershipRole: institutionMemberships.membershipRole,
      logoR2Key: institutions.logoR2Key,
      bannerR2Key: institutions.bannerR2Key,
      ownerAvatarKey: institutionOwnerAvatarKeySql,
      ownerBannerKey: institutionOwnerBannerKeySql,
    })
    .from(institutionMemberships)
    .innerJoin(institutions, eq(institutions.id, institutionMemberships.institutionId))
    .where(
      and(
        eq(institutionMemberships.userId, userId),
        eq(institutionMemberships.status, ACTIVE_MEMBERSHIP_STATUS),
        inArray(institutionMemberships.membershipRole, [OWNER_ROLE, STAFF_ROLE]),
      ),
    )
    .orderBy(institutions.createdAt);

  const staffCountByInstitution = await countActiveOperationalMembers(
    rows.map((row) => row.institutionId),
    db,
  );

  return await Promise.all(
    rows.map(async (row) => {
      const { logoUrl, bannerUrl } = await resolveInstitutionMediaUrls(
        {
          institutionType: row.institutionType,
          logoR2Key: row.logoR2Key,
          bannerR2Key: row.bannerR2Key,
        },
        { avatarR2Key: row.ownerAvatarKey, bannerR2Key: row.ownerBannerKey },
      );

      return {
        institutionId: row.institutionId,
        slug: row.slug,
        // Personal institutions render as a generic "Personal" here rather than the owner-derived
        // "<username>'s Institution" the global helper produces.
        displayName: isPersonalInstitutionType(row.institutionType)
          ? "Personal"
          : getInstitutionDisplayName({
              displayName: row.displayName,
              institutionType: row.institutionType,
            }),
        about: row.about,
        description: row.description,
        role: row.membershipRole as typeof OWNER_ROLE | typeof STAFF_ROLE,
        isOwner: row.membershipRole === OWNER_ROLE,
        staffCount: staffCountByInstitution.get(row.institutionId) ?? 0,
        logoUrl,
        bannerUrl,
      };
    }),
  );
};

// Counts active operational members (owner + staff, excluding cosmetic institution_member) per
// institution for a set of institution ids, in one grouped query. Returns a map keyed by
// institutionId; an institution with no counted members is simply absent (caller defaults to 0).
const countActiveOperationalMembers = async (
  institutionIds: string[],
  db: Database,
): Promise<Map<string, number>> => {
  if (institutionIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      institutionId: institutionMemberships.institutionId,
      value: count(),
    })
    .from(institutionMemberships)
    .where(
      and(
        inArray(institutionMemberships.institutionId, institutionIds),
        eq(institutionMemberships.status, ACTIVE_MEMBERSHIP_STATUS),
        inArray(institutionMemberships.membershipRole, [OWNER_ROLE, STAFF_ROLE]),
      ),
    )
    .groupBy(institutionMemberships.institutionId);

  return new Map(rows.map((row) => [row.institutionId, row.value]));
};

// Counts the institutions this user actively owns (active institution_owner membership), of every
// kind. The one count behind the per-owner cap, read by the fast pre-check and by the re-check under
// the owner lock.
const countOwnedInstitutions = async (userId: string, db: Database): Promise<number> => {
  const rows = await db
    .select({ value: count() })
    .from(institutionMemberships)
    .innerJoin(institutions, eq(institutions.id, institutionMemberships.institutionId))
    .where(
      and(
        eq(institutionMemberships.userId, userId),
        eq(institutionMemberships.membershipRole, OWNER_ROLE),
        eq(institutionMemberships.status, ACTIVE_MEMBERSHIP_STATUS),
      ),
    );
  return rows[0]?.value ?? 0;
};

// The 409 a caller sees when the cap is reached. Built in one place so the fast app-layer pre-check
// and the in-transaction re-check behind the owner lock throw a byte-identical error, and a caller
// cannot tell which guard tripped.
const buildInstitutionLimitError = (): InstitutionWorkspaceInputError =>
  new InstitutionWorkspaceInputError(
    "recruiter_institution_limit_reached",
    `Recruiter may own at most ${MAX_INSTITUTIONS_PER_RECRUITER} institutions`,
    undefined,
    409,
  );

// Slug-collision-retrying insert of an institution row plus its institution_owner membership, in a
// single transaction. The slug is the one the user typed, or else derives from the display name.
type InsertInstitutionParams = {
  displayName: string;
  explicitSlug: string | null;
};

const insertInstitutionWithOwner = async (
  userId: string,
  params: InsertInstitutionParams,
  institutionType: InstitutionType,
  db: Database,
): Promise<InstitutionWorkspaceShell> => {
  const baseSlug = params.explicitSlug ?? deriveInstitutionSlugBase(params.displayName);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = buildInstitutionSlugCandidate(baseSlug, attempt);

    // Flat-namespace guard (Fix C extended to the suffixed candidate). createInstitutionWorkspaceForUser
    // already checked the BASE slug against usernames. This re-checks each SUFFIXED candidate the slug
    // collision retry produces (a username `acme_2` would occupy slug `acme-2`) and bumps the suffix on
    // a username collision, so the loop converges on a slug clear of both institutions.slug AND
    // users.username. Exhaustion falls through to the shared "slug is not available" throw below.
    if (await institutionSlugCollidesWithUsername(candidateSlug, db)) {
      continue;
    }

    try {
      return await db.transaction(async (tx) => {
        // A de-identified account is a tombstone the person is no longer reachable through, so the
        // membership created below is one nobody could ever act as. Refused first, before the cap
        // lock and before anything is counted or written.
        await assertAccountNotDeactivated(tx, userId, InstitutionDeactivatedError);

        // Serialize same-owner cap-guarded mutations, then re-count every one of the owner's
        // institutions UNDER the lock: this is the true cap guard. A plain count (in or out of the
        // transaction) cannot see a concurrent same-owner insert under READ COMMITTED — see
        // acquireOwnerCapLock. The fast pre-check in the caller stays as the friendly-409 path.
        await acquireOwnerCapLock(tx, userId);

        const ownedCount = await countOwnedInstitutions(userId, tx);
        if (ownedCount >= MAX_INSTITUTIONS_PER_RECRUITER) {
          throw buildInstitutionLimitError();
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
            institutionDescription: institutions.description,
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
          null,
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

// A person whose host trust staff removed opens no new workspace: each one is a new public organizer
// page and a new name to send invitations under. The workspaces they already run stay theirs.
// Throws InstitutionWorkspaceInputError 403 institution_create_blocked_trust_removed.
const assertCreatorHostTrustNotRemoved = async (userId: string, db: Database): Promise<void> => {
  const trustRemoved = await isHostTrustRemoved(userId, db);
  if (!trustRemoved) return;
  throw new InstitutionWorkspaceInputError(
    "institution_create_blocked_trust_removed",
    "A host whose trust staff removed cannot create a workspace",
    undefined,
    403,
  );
};

// Workspace creation for every kind. The recruiter-tier gate is enforced in the route layer via
// assertRecruiterTier. This service refuses a host whose trust staff removed, and owns the per-owner
// limit, which counts every institution the user actively owns, whatever its kind. The created row
// carries the kind and the name chosen on the create form.
export const createInstitutionWorkspaceForUser = async (
  userId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<InstitutionWorkspaceShell> => {
  await assertCreatorHostTrustNotRemoved(userId, db);

  const ownedCount = await countOwnedInstitutions(userId, db);

  if (ownedCount >= MAX_INSTITUTIONS_PER_RECRUITER) {
    throw buildInstitutionLimitError();
  }

  // Service-layer NOT NULL invariant (replaces the loosened DB constraint from migration 0031):
  // parseInstitutionWorkspaceCreateInput requires a 2–160 char displayName and throws
  // institution_invalid_value on a missing / empty / non-string value, so an institution can
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
    { displayName: input.displayName, explicitSlug: input.slug },
    input.institutionType,
    db,
  );
};

// Returns a personal institution the user actively owns (id and current slug), or null when the user
// owns none.
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

// True when any institution already holds the slug a username would normalize to. Usernames and
// institution slugs share one namespace, and no institution is excluded: a user's own workspace keeps
// its slug when the username changes, so taking that slug as a username is a conflict too.
export const usernameCollidesWithInstitutionSlug = async (
  newUsername: string,
  db: DbOrTx = getDb(),
): Promise<boolean> => {
  const candidateSlug = deriveInstitutionSlugBase(newUsername);

  const [row] = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.slug, candidateSlug))
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
// the other direction). Creating a new institution moves no existing name, so there is no
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

  const updates: {
    displayName?: string;
    slug?: string;
    description?: string | null;
    updatedAt?: ReturnType<typeof sql>;
  } = {};

  if (patch.displayName !== undefined && patch.displayName !== current.institutionDisplayName) {
    updates.displayName = patch.displayName;
  }

  if (patch.slug !== undefined && patch.slug !== current.institutionSlug) {
    updates.slug = patch.slug;
  }

  if (patch.description !== undefined && patch.description !== current.institutionDescription) {
    updates.description = patch.description;
  }

  if (Object.keys(updates).length === 0) {
    return mapInstitutionWorkspace(current, current.ownerUsername);
  }

  // Flat-namespace guard: a new slug must not collide with an existing user's username. No exclusion
  // carve-out: renaming this institution moves no existing name onto a user, so any username match is
  // a real conflict. It sits beside the reserved-word check (in parseSlug) and the institutions.slug
  // uniqueness catch below, and their order is functional only.
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
  // Presigned read URLs, not stored paths. For a personal institution these resolve to the owner's
  // own profile photo and banner, which is why the surface reports them as URLs rather than as
  // "has an upload" flags — the images exist, they are just not this institution's to edit.
  logoUrl: string | null;
  bannerUrl: string | null;
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
      institutionType: institutions.institutionType,
      logoR2Key: institutions.logoR2Key,
      bannerR2Key: institutions.bannerR2Key,
      ownerAvatarKey: institutionOwnerAvatarKeySql,
      ownerBannerKey: institutionOwnerBannerKeySql,
    })
    .from(institutions)
    .where(eq(institutions.id, current.institutionId));

  const links = await db
    .select({ platform: institutionSocialLinks.platform, url: institutionSocialLinks.url })
    .from(institutionSocialLinks)
    .where(eq(institutionSocialLinks.institutionId, current.institutionId));

  const { logoUrl, bannerUrl } = await resolveInstitutionMediaUrls(
    {
      institutionType: row?.institutionType ?? null,
      logoR2Key: row?.logoR2Key ?? null,
      bannerR2Key: row?.bannerR2Key ?? null,
    },
    { avatarR2Key: row?.ownerAvatarKey ?? null, bannerR2Key: row?.ownerBannerKey ?? null },
  );

  return {
    about: row?.about ?? null,
    contactName: row?.contactName ?? null,
    contactEmail: row?.contactEmail ?? null,
    contactPhone: row?.contactPhone ?? null,
    websiteUrl: row?.websiteUrl ?? null,
    logoUrl,
    bannerUrl,
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

// Logo and banner upload live in institution-media-service.ts, which also owns the personal-
// institution derivation both images share.

// Resolve an institution's type by slug for owner-or-staff UI surfaces
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

export type InstitutionVerificationSummary = {
  institutionId: string;
  institutionType: InstitutionType;
  verificationStatus: InstitutionVerificationStatus;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  displayName: string;
};

// Everything the verification page of a workspace needs: the type decides whether the page sends a
// personal workspace's owner to its hub, and the status decides whether the document-verification
// view still accepts a submission or only reports the verdict already reached. Returns null for a
// slug that does not resolve.
export const loadInstitutionVerificationSummaryBySlug = async (
  institutionSlug: string,
  db: Database = getDb(),
): Promise<InstitutionVerificationSummary | null> => {
  const normalized = normalizeInstitutionSlug(institutionSlug);
  const [row] = await db
    .select({
      institutionId: institutions.id,
      institutionType: institutions.institutionType,
      verificationStatus: institutions.verificationStatus,
      verifiedAt: institutions.verifiedAt,
      rejectionReason: institutions.rejectionReason,
      rawDisplayName: institutions.displayName,
      ownerUsername: institutionOwnerUsernameSql,
    })
    .from(institutions)
    .where(eq(institutions.slug, normalized))
    .limit(1);
  if (!row) {
    return null;
  }
  const { rawDisplayName, ownerUsername, ...rest } = row;
  return {
    ...rest,
    displayName: getInstitutionDisplayName(
      { displayName: rawDisplayName, institutionType: row.institutionType },
      { username: ownerUsername },
    ),
  };
};
