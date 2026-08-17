import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { APP_ROLES, DEFAULT_APP_ROLE } from "@/lib/access/roles";
import {
  FEE_ACCRUAL_ENTRY_TYPES,
  MANUAL_PAYMENT_PROOF_STATUSES,
  PAYMENT_EVENT_ACTOR_TYPES,
  PAYMENT_EVENT_TYPES,
  PAYMENT_ORIGINS,
  PAYMENT_SUBJECT_TYPES,
} from "@/lib/finance/payment-model";
import {
  DEFAULT_PAYMENT_WINDOW_DAYS,
  MAX_PAYMENT_WINDOW_DAYS,
  MIN_PAYMENT_WINDOW_DAYS,
} from "@/lib/finance/payment-window";

export const appRoleEnum = pgEnum("app_role", APP_ROLES);

export const appUserStatusEnum = pgEnum("app_user_status", ["active", "suspended", "deactivated"]);

// `platform_user_role` is the auxiliary user-platform-roles table enum.
// The `student` token is renamed to `candidate` in lockstep with appRoleEnum.
// `recruiter` is intentionally NOT added here yet — recruiter-side platform-role wiring is
// out of scope here; the current consumers only need parity with the primary role
// values that can also appear as elevated platform roles (platform_ops, finance_ops).
export const platformUserRoleEnum = pgEnum("platform_user_role", [
  "candidate",
  "platform_ops",
  "finance_ops",
]);

// Fixed set of social platforms a profile may link to (one link per platform per user).
export const profileSocialPlatformEnum = pgEnum("profile_social_platform", [
  "linkedin",
  "github",
  "instagram",
  "x",
  "website",
]);

export const institutionStatusEnum = pgEnum("institution_status", [
  "active",
  "inactive",
  "suspended",
]);

export const institutionVerificationStatusEnum = pgEnum("institution_verification_status", [
  "pending_verification",
  "under_review",
  "verified",
  "rejected",
]);

export const institutionMembershipRoleEnum = pgEnum("institution_membership_role", [
  "institution_owner",
  "institution_staff",
  "institution_member",
]);

// Institution type taxonomy. The column is nullable: a NULL value is a legacy
// full/standard institution whose concrete subtype was never declared (all rows created before
// `personal` is the lightweight, single-member, capped institution a minimal-tier recruiter can
// self-create. The four full subtypes (company|foundation|university|campus_organization) are
// chosen at create time for a directly-created full institution, or at upgrade time for a
// personal→full upgrade — never left undeclared. Predicate convention: "is personal" is
// `institution_type = 'personal'`; "is full/standard" is `institution_type <> 'personal'`.
// `community` is intentionally absent (deferred post-Beta). The enum is forward-compatible with
// Phase 8 opportunity types — no jobs/internship wiring is added here.
export const institutionTypeEnum = pgEnum("institution_type", [
  "personal",
  "company",
  "foundation",
  "university",
  "campus_organization",
]);

export const institutionMembershipStatusEnum = pgEnum("institution_membership_status", [
  "invited",
  "active",
  "inactive",
  "revoked",
]);

export const institutionInvitationStatusEnum = pgEnum("institution_invitation_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
  "cancelled",
  // Invited address has no account yet (target_user_id IS NULL). The invite is
  // inbox-invisible until the invited email registers and verifies, at which point claim-at-signup
  // attaches it to the new user and flips it to `pending`. `pending` always means
  // invited-with-account, awaiting accept.
  "pending_claim",
]);

// Recruiter verification tier.
// Per-account tier dimension that refines the recruiter role's capability surface. Auto-granted
// to `minimal` at recruiter signup; only `platform_ops` can lift an account to `elevated` (manual
// review at launch — there is no mechanical verification flow). Tier is monotonically
// increasing at launch — no downgrade path.
//   unverified — schema default for backfilled rows + non-recruiter accounts. Not reachable
//                naturally for recruiter signups (signup auto-grants `minimal` atomically).
//   minimal    — auto-granted on `?as=recruiter` signup. Satisfies the opportunity-creation gate.
//   elevated   — manually granted by platform_ops via PATCH /api/platform-ops/accounts/[id]/recruiter-tier.
export const recruiterVerificationTierEnum = pgEnum("recruiter_verification_tier", [
  "unverified",
  "minimal",
  "elevated",
]);

export type RecruiterVerificationTier = (typeof recruiterVerificationTierEnum.enumValues)[number];

// "archived" is retained because Postgres cannot drop an enum value. No application path can
// produce it: a competition is either a draft or published, and how far along it is reads from
// its dates and its results rather than from a status flip. Read paths still tolerate the value.
export const competitionStatusEnum = pgEnum("competition_status", [
  "draft",
  "published",
  "archived",
]);

export const competitionModeEnum = pgEnum("competition_mode", ["individual", "team", "both"]);

// competition_category enum: competition-type taxonomy (Brand Book §8 + Indonesia student
// competition types). "other" is the safety-valve value. Display labels live in the single
// source of truth at @/lib/competitions/categories.
export const competitionCategoryEnum = pgEnum("competition_category", [
  "hackathon",
  "scientific_writing",
  "essay",
  "debate",
  "olympiad",
  "business",
  "engineering",
  "finance",
  "law",
  "design",
  "data_science",
  "programming",
  "marketing",
  "digital_art",
  "infographics",
  "performing_arts",
  "esports",
  "quiz",
  "other",
]);

export type CompetitionMode = (typeof competitionModeEnum.enumValues)[number];
export type CompetitionStatus = (typeof competitionStatusEnum.enumValues)[number];
export type CompetitionCategory = (typeof competitionCategoryEnum.enumValues)[number];

// Candidate self-declared current occupation, captured at candidate onboarding. Purely
// descriptive — it does not gate access. Anyone of any age and any occupation may register as a
// candidate; this field records where they are in life for segmentation and display.
export const candidateOccupationEnum = pgEnum("candidate_occupation", [
  "school_student",
  "college_student",
  "new_graduate",
  "professional",
  "other",
]);

export type CandidateOccupation = (typeof candidateOccupationEnum.enumValues)[number];

export type AppUserStatus = (typeof appUserStatusEnum.enumValues)[number];
export type InstitutionInvitationStatus =
  (typeof institutionInvitationStatusEnum.enumValues)[number];
export type InstitutionMembershipRole = (typeof institutionMembershipRoleEnum.enumValues)[number];
export type InstitutionMembershipStatus =
  (typeof institutionMembershipStatusEnum.enumValues)[number];
export type InstitutionStatus = (typeof institutionStatusEnum.enumValues)[number];
export type InstitutionType = (typeof institutionTypeEnum.enumValues)[number];
export type InstitutionVerificationStatus =
  (typeof institutionVerificationStatusEnum.enumValues)[number];
export type PlatformUserRole = (typeof platformUserRoleEnum.enumValues)[number];

// Per-role verification persistence.
// `candidateVerifiedAt` and `recruiterVerifiedAt` independently record whether each user-level
// role mode has been verified for this account. Every account must hold at least one non-null
// timestamp — enforced by a DB-level CHECK constraint (`users_one_verified_role_chk`) so the
// invariant survives any code path that creates or modifies user rows. Tier refinement for the
// recruiter mode lives in `recruiterVerificationTier` below; these two columns carry only the
// per-mode verification timestamp.
//
// `username` added as the canonical public URL handle for the user
// profile shell. Auto-generated at account creation; editable at /profile/edit subject to
// uniqueness + reserved-word validation. Unique index enforced at DB level.
export const users = pgTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    name: text("name"),
    email: text("email").notNull().unique(),
    emailVerified: timestamp("email_verified", { mode: "date", withTimezone: true }),
    image: text("image"),
    role: appRoleEnum("role").notNull().default(DEFAULT_APP_ROLE),
    status: appUserStatusEnum("status").notNull().default("active"),
    username: text("username").notNull(),
    candidateVerifiedAt: timestamp("candidate_verified_at", {
      mode: "date",
      withTimezone: true,
    }),
    recruiterVerifiedAt: timestamp("recruiter_verified_at", {
      mode: "date",
      withTimezone: true,
    }),
    // Recruiter tier dimension. Placed on `users` (not a
    // parallel table) so it sits adjacent to the per-role verification timestamps and shares
    // their lifecycle. Non-null with default `unverified`; recruiter signup writes `minimal`
    // atomically alongside `recruiterVerifiedAt`. See `assertRecruiterTier` for the read path.
    recruiterVerificationTier: recruiterVerificationTierEnum("recruiter_verification_tier")
      .notNull()
      .default("unverified"),
    // Platform ops moderation. Suspension is an operational gate distinct from the
    // user-level `status` enum and from per-role verification. A non-null `suspendedAt` blocks the
    // account on its next authenticated request via the session-callback DB check (immediate
    // effect, not deferred to JWT rotation). `suspensionReason` records the ops actor's reason.
    suspendedAt: timestamp("suspended_at", { mode: "date", withTimezone: true }),
    suspensionReason: text("suspension_reason"),
    // MFA session-invalidation stamp. Lives on `users`, not on `mfa_factors`, so the
    // DEC-0112 live-session read stays ONE indexed-PK SELECT with one extra projected column rather
    // than gaining a join. A non-null bump (written on recovery-code redemption / reset) means any
    // JWT carrying an `mfaVerifiedAt` claim earlier than this instant is stale and must re-challenge
    // — the same "compare a stamp on the token against a stamp on the row" shape as suspension.
    mfaInvalidatedAt: timestamp("mfa_invalidated_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("users_username_unique_idx").on(table.username),
    check(
      "users_one_verified_role_chk",
      sql`${table.candidateVerifiedAt} IS NOT NULL OR ${table.recruiterVerifiedAt} IS NOT NULL`,
    ),
    // Recruiter tier consistency invariant. Any row holding a non-null
    // recruiterVerifiedAt must also hold a tier above 'unverified'. Enforced at the DB so any
    // write path that forgets to set the tier (e.g. a future verification flow) is rejected at
    // INSERT/UPDATE time rather than silently producing an inconsistent row. The application
    // already writes 'minimal' atomically at signup (credentials-auth.ts) and at the second-role
    // stub (role-verification.ts); this CHECK is the safety net.
    check(
      "users_recruiter_tier_consistency_chk",
      sql`${table.recruiterVerifiedAt} IS NULL OR ${table.recruiterVerificationTier} <> 'unverified'`,
    ),
  ],
);

// Profile shell rebuild.
// `summary` column is kept as-is (closing the rename debt is deferred: see CURRENT_STATE.md
// known debt). The new user-profile API exposes it as `bio`. Old student-profile code continues
// to reference it as `summary` → `headline` without disruption.
// `phoneNumber` retained for backward compat with pre-rollback student-profile code.
// Remaining scalar fields are all "shared" — readable/writable by any account, no per-role
// scope gating. The former candidate-scoped (university, major, graduation_year) and
// recruiter-scoped (role_title, organization_name, website_url) columns were retired: their data
// now lives in the multi-row profile collection tables below (profile_educations,
// profile_experiences, profile_social_links), which are role-agnostic.
export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  phoneNumber: text("phone_number"),
  // `avatar_url` is a legacy external-URL fallback (no longer editable). The uploaded avatar is
  // stored as an R2 object key in `avatar_r2_key`; the read path presigns a short-lived GET URL.
  avatarUrl: text("avatar_url"),
  avatarR2Key: text("avatar_r2_key"),
  // Wide header image behind the profile identity block, stored as an R2 object key and presigned
  // on read like the avatar. Cropped client-side to a fixed 4:1 frame before upload.
  bannerR2Key: text("banner_r2_key"),
  summary: text("summary"),
  location: text("location"),
  // Single resume per user (uploaded to R2). `resume_public` gates whether it appears on the
  // public profile; it is owner-only by default.
  resumeR2Key: text("resume_r2_key"),
  resumeFileName: text("resume_file_name"),
  resumeSizeBytes: bigint("resume_size_bytes", { mode: "number" }),
  resumeMimeType: text("resume_mime_type"),
  resumeUploadedAt: timestamp("resume_uploaded_at", { mode: "date", withTimezone: true }),
  resumePublic: boolean("resume_public").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});

// Profile detail collections. Every row is scoped to one user (FK ON DELETE CASCADE) and is
// role-agnostic: any signed-in account may add entries regardless of candidate/recruiter
// verification. Verification badges still render on the profile, but they no longer gate which
// sections a user can fill. These tables replace the single scalar profile fields retired above.
export const profileExperiences = pgTable(
  "profile_experiences",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    organizationName: text("organization_name").notNull(),
    location: text("location"),
    // Month-granularity in practice (stored as first-of-month). Nullable: "dates optional" UX and
    // the legacy backfill (old recruiter fields carried no dates) both need a null-start entry.
    startDate: date("start_date", { mode: "date" }),
    endDate: date("end_date", { mode: "date" }),
    isCurrent: boolean("is_current").notNull().default(false),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("profile_experiences_user_id_idx").on(table.userId),
    check(
      "profile_experiences_date_order_chk",
      sql`${table.startDate} IS NULL OR ${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
    ),
    check(
      "profile_experiences_current_no_end_chk",
      sql`${table.isCurrent} = false OR ${table.endDate} IS NULL`,
    ),
  ],
);

export const profileEducations = pgTable(
  "profile_educations",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    school: text("school").notNull(),
    degree: text("degree"),
    fieldOfStudy: text("field_of_study"),
    startYear: integer("start_year"),
    endYear: integer("end_year"),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("profile_educations_user_id_idx").on(table.userId),
    check(
      "profile_educations_year_order_chk",
      sql`${table.startYear} IS NULL OR ${table.endYear} IS NULL OR ${table.endYear} >= ${table.startYear}`,
    ),
  ],
);

export const profileSkills = pgTable(
  "profile_skills",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("profile_skills_user_id_idx").on(table.userId),
    // Case-insensitive uniqueness per user: no duplicate skill regardless of casing.
    uniqueIndex("profile_skills_user_name_unique_idx").on(table.userId, sql`lower(${table.name})`),
  ],
);

export const profileCertifications = pgTable(
  "profile_certifications",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    issuer: text("issuer").notNull(),
    issueDate: date("issue_date", { mode: "date" }),
    expiryDate: date("expiry_date", { mode: "date" }),
    credentialId: text("credential_id"),
    credentialUrl: text("credential_url"),
    // Optional uploaded certificate file, stored as an R2 object key (read path presigns a GET URL).
    fileR2Key: text("file_r2_key"),
    fileName: text("file_name"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    fileMimeType: text("file_mime_type"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("profile_certifications_user_id_idx").on(table.userId)],
);

export const profileSocialLinks = pgTable(
  "profile_social_links",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: profileSocialPlatformEnum("platform").notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("profile_social_links_user_id_idx").on(table.userId),
    // One link per platform per user (fixed platform set).
    uniqueIndex("profile_social_links_user_platform_unique_idx").on(table.userId, table.platform),
  ],
);

export const userPasswordCredentials = pgTable("user_password_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});

export const userEmailVerificationTokens = pgTable(
  "user_email_verification_tokens",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_email_verification_tokens_token_hash_unique_idx").on(table.tokenHash),
  ],
);

export const userPlatformRoles = pgTable(
  "user_platform_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: platformUserRoleEnum("role").notNull(),
    assignedAt: timestamp("assigned_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.role],
    }),
  ],
);

export const institutions = pgTable(
  "institutions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    // Nullable: a personal institution stores NULL here and derives its user-facing name from the
    // owner's current username at read time. Full/legacy institutions (type !== 'personal') store a
    // non-null value, enforced at the service layer (createInstitutionWorkspaceForUser). ALWAYS read
    // a user-facing institution name through getInstitutionDisplayName (institution-display-name.ts)
    // — never read this column raw on any surface that shows a name to a user.
    displayName: text("display_name"),
    slug: text("slug").notNull(),
    status: institutionStatusEnum("status").notNull().default("active"),
    // Institution type. NOT NULL: every institution declares a type at creation — `personal` via
    // the personal-create path, or a full subtype via the full-create form / personal→full upgrade.
    // `personal` rows are capped (≤2 published competitions, individual-only, no featured placement,
    // no staff/member invites); full subtypes are unconstrained by those caps. See institution-type.ts
    // for the predicates and the type-transition state machine.
    institutionType: institutionTypeEnum("institution_type").notNull(),
    // Short free-text description of the institution, editable in institution settings for EVERY
    // type (personal included) and surfaced on the recruiter dashboard institution list. Nullable —
    // an institution that has not written one falls back to a placeholder. Distinct from the
    // full-only public organizer `about` field below (which drives the competition-detail
    // "Penyelenggara" surface and is edited on the separate /settings/profile sub-page).
    description: text("description"),
    verificationStatus: institutionVerificationStatusEnum("verification_status")
      .notNull()
      .default("pending_verification"),
    verifiedAt: timestamp("verified_at", { mode: "date", withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { mode: "date", withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    // Platform ops moderation. Suspension is a separate operational axis from
    // `verificationStatus`: a verified institution can be suspended, and reinstatement restores
    // operations without touching verification_status. `assertInstitutionNotSuspended` reads this
    // alongside `assertInstitutionVerified` on the competition create/publish paths.
    suspendedAt: timestamp("suspended_at", { mode: "date", withTimezone: true }),
    suspensionReason: text("suspension_reason"),
    // Public organizer profile (competition detail "Penyelenggara" surface). All nullable —
    // an organizer that has not enriched its profile falls back to the derived display name and
    // a placeholder mark. `logoR2Key` is a private R2 object key; the read path signs a fresh GET
    // URL at render time (never a stored public URL). These fields are descriptive only.
    logoR2Key: text("logo_r2_key"),
    // Wide header image on the public institution page, same 4:1 frame as the profile banner.
    // Personal institutions never write either key — their logo and banner are derived from the
    // owner's own profile at read time (see resolveInstitutionMedia).
    bannerR2Key: text("banner_r2_key"),
    about: text("about"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    websiteUrl: text("website_url"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("institutions_slug_unique_idx").on(table.slug),
    // Backstop for the 6.5f.1-S1 debt: full/legacy institutions must store a non-null
    // display_name. Personal institutions are exempt (type = 'personal' short-circuits the OR).
    check(
      "institutions_display_name_type_chk",
      sql`${table.institutionType} = 'personal' OR ${table.displayName} IS NOT NULL`,
    ),
  ],
);

// Public organizer social links — mirrors profile_social_links but keyed to an institution.
// Reuses profile_social_platform (linkedin | github | instagram | x | website); one link per
// platform per institution. Descriptive only.
export const institutionSocialLinks = pgTable(
  "institution_social_links",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    platform: profileSocialPlatformEnum("platform").notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("institution_social_links_institution_id_idx").on(table.institutionId),
    uniqueIndex("institution_social_links_institution_platform_unique_idx").on(
      table.institutionId,
      table.platform,
    ),
  ],
);

export const institutionMemberships = pgTable(
  "institution_memberships",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    membershipRole: institutionMembershipRoleEnum("membership_role").notNull(),
    status: institutionMembershipStatusEnum("status").notNull().default("active"),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    joinedAt: timestamp("joined_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("institution_membership_institution_user_unique_idx").on(
      table.institutionId,
      table.userId,
    ),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (table) => [
    primaryKey({
      columns: [table.provider, table.providerAccountId],
    }),
  ],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.identifier, table.token],
    }),
  ],
);

// institution_memberships already has institution_membership_institution_user_unique_idx
// on (institution_id, user_id) — no additional constraint needed here.
export const institutionInvitations = pgTable(
  "institution_invitations",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    invitedEmail: text("invited_email").notNull(),
    invitedRole: institutionMembershipRoleEnum("invited_role").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: institutionInvitationStatusEnum("status").notNull().default("pending"),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Recipient resolution for the in-app inbox. Backfilled (migration 0027) by
    // matching invited_email to an existing user; populated at invite time or claim-at-signup.
    // ON DELETE SET NULL: the invitation row outlives a deleted target user.
    // The inbox queries ONLY by target_user_id — invitations with a null value are invisible
    // until the claim flow attaches them. invited_email remains the token-based acceptance anchor.
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("institution_invitations_token_hash_unique_idx").on(table.tokenHash),
    index("institution_invitations_institution_id_idx").on(table.institutionId),
    index("institution_invitations_status_idx").on(table.status),
    index("institution_invitations_target_user_id_idx").on(table.targetUserId),
  ],
);

export const institutionAuditLogs = pgTable(
  "institution_audit_logs",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetMembershipId: text("target_membership_id").references(() => institutionMemberships.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("institution_audit_logs_institution_id_idx").on(table.institutionId),
    index("institution_audit_logs_action_idx").on(table.action),
  ],
);

export const institutionVerificationAudit = pgTable(
  "institution_verification_audit",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    fromStatus: institutionVerificationStatusEnum("from_status").notNull(),
    toStatus: institutionVerificationStatusEnum("to_status").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("institution_verification_audit_institution_id_idx").on(table.institutionId),
    index("institution_verification_audit_created_at_idx").on(table.createdAt),
  ],
);

// Platform ops internal notes. A note targets exactly one of a user OR an institution
// (the DB CHECK enforces the XOR). Notes are support context only — never surfaced to the target.
// FKs to the target are ON DELETE CASCADE so notes do not outlive a hard-deleted target;
// `createdById` (the ops actor) has no cascade so the authoring identity is preserved.
export const platformOpsNotes = pgTable(
  "platform_ops_notes",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "cascade" }),
    targetInstitutionId: text("target_institution_id").references(() => institutions.id, {
      onDelete: "cascade",
    }),
    note: text("note").notNull(),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("platform_ops_notes_target_user_id_idx").on(table.targetUserId),
    index("platform_ops_notes_target_institution_id_idx").on(table.targetInstitutionId),
    // Exactly one target: user XOR institution.
    check(
      "platform_ops_notes_single_target_chk",
      sql`(${table.targetUserId} IS NOT NULL AND ${table.targetInstitutionId} IS NULL) OR (${table.targetUserId} IS NULL AND ${table.targetInstitutionId} IS NOT NULL)`,
    ),
  ],
);

// Append-only platform ops moderation audit trail. Distinct from
// `institution_audit_logs` (institution-scoped, member-level events): this table records
// platform-level actor events (user/institution suspension, reinstatement) keyed on the acting
// platform_ops user. At least one of the two target columns is non-null (DB CHECK).
export const platformOpsAuditLogs = pgTable(
  "platform_ops_audit_logs",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    // No ON DELETE behaviour (restrict): hard deletion of users/institutions is out of scope for
    // this step, and an append-only audit trail must keep its target reference valid — a SET NULL
    // would violate the target_present CHECK for a single-target row.
    targetUserId: text("target_user_id").references(() => users.id),
    targetInstitutionId: text("target_institution_id").references(() => institutions.id),
    eventType: text("event_type").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("platform_ops_audit_logs_target_user_id_idx").on(table.targetUserId),
    index("platform_ops_audit_logs_target_institution_id_idx").on(table.targetInstitutionId),
    check(
      "platform_ops_audit_logs_target_present_chk",
      sql`${table.targetUserId} IS NOT NULL OR ${table.targetInstitutionId} IS NOT NULL`,
    ),
  ],
);

// Competition domain model.
// Slug uniqueness is institution-scoped — UNIQUE (institution_id, slug). Two institutions may
// reuse the same human-readable slug (e.g. "hackathon-2026") without collision.
// Deletion model: drafts soft-delete via deleted_at. Published records are not deletable through
// DELETE — a published competition must be unpublished back to draft first. A finished competition
// stays published so its public record, organizer contact details, and results remain reachable.
// Payment fields (fee_amount, fee_currency) are deferred to Phase 7 — schema-present but must
// be null/0 in MVP flows. CHECK (fee_amount >= 0) is added in the migration.
export const competitions = pgTable(
  "competitions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: competitionStatusEnum("status").notNull().default("draft"),
    category: competitionCategoryEnum("category"),
    mode: competitionModeEnum("mode"),
    minTeamSize: integer("min_team_size"),
    maxTeamSize: integer("max_team_size"),
    registrationStartAt: timestamp("registration_start_at", { mode: "date", withTimezone: true }),
    registrationEndAt: timestamp("registration_end_at", { mode: "date", withTimezone: true }),
    eventStartAt: timestamp("event_start_at", { mode: "date", withTimezone: true }),
    eventEndAt: timestamp("event_end_at", { mode: "date", withTimezone: true }),
    // The date the organizer commits to announcing results. Nullable while drafting and on legacy
    // rows, but required by publish validation so participants know when to expect an outcome.
    resultAnnouncementAt: timestamp("result_announcement_at", {
      mode: "date",
      withTimezone: true,
    }),
    // Optional minimum-entry commitment. Zero means no minimum; a positive value enables the
    // insufficient-participation decision. One individual registration counts as one entry and one
    // submitted team counts as one entry, regardless of team size. The confirmation timestamp is
    // independently required at publish time because it also closes participant withdrawals.
    minimumParticipantEntries: integer("minimum_participant_entries"),
    participantConfirmationAt: timestamp("participant_confirmation_at", {
      mode: "date",
      withTimezone: true,
    }),
    // Set only when an organizer explicitly commits to proceed despite an unmet minimum. When the
    // count meets the minimum at participant_confirmation_at, confirmation is derived from the
    // stable count instead and this column remains null.
    participationConfirmedAt: timestamp("participation_confirmed_at", {
      mode: "date",
      withTimezone: true,
    }),
    // Competition cancellation is a terminal display axis, separate from publication status:
    // cancelled competitions deliberately remain status='published' so their public record stays
    // reachable. cancellation_reason stores the machine-readable reason token.
    cancelledAt: timestamp("cancelled_at", { mode: "date", withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    // Candidate-cancellation policy. allow_cancellation is the institution
    // opt-in toggle; cancellation_cutoff_days is the number of days before event_start_at after
    // which self-cancellation is closed. cutoff is only meaningful when allow_cancellation is true
    // (enforced by competitions_cancellation_policy_chk below).
    allowCancellation: boolean("allow_cancellation").notNull().default(false),
    cancellationCutoffDays: integer("cancellation_cutoff_days"),
    // INTEGER SMALLEST UNIT, paired with fee_currency — the convention lives in
    // @/lib/finance/money and nowhere else. IDR is exponent 0, so 50000 means Rp 50.000. This was
    // a `numeric(12,2)` read as a string and coerced with Number.parseFloat, which is exactly the
    // shape money.ts exists to forbid: a decimal column invites a float parse, and a float cannot
    // represent money. NULL and 0 both mean free (see isPaidCompetition).
    feeAmount: bigint("fee_amount", { mode: "number" }),
    feeCurrency: text("fee_currency"),
    // How many days a candidate has to send a bukti transfer before the payment lapses. The
    // resolved DEADLINE is snapshotted per payment (finance_payments.due_at) and is never
    // recomputed from this column, so shortening the window cannot move a deadline someone has
    // already been given. See @/lib/finance/payment-window.
    paymentWindowDays: integer("payment_window_days")
      .notNull()
      .default(DEFAULT_PAYMENT_WINDOW_DAYS),
    // Descriptive, organizer-authored eligibility note. Display ONLY — never read to authorize any
    // action (open candidacy, DEC-0106). Registration remains open to every verified candidate.
    eligibilityNote: text("eligibility_note"),
    isFeatured: boolean("is_featured").notNull().default(false),
    featuredOrder: integer("featured_order"),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("competitions_institution_id_slug_unique_idx").on(table.institutionId, table.slug),
    index("competitions_institution_id_idx").on(table.institutionId),
    index("competitions_status_idx").on(table.status),
    // Composite index for the public listing query: filters by status=published and optionally
    // by institution_id. Prevents a full-table scan when listing published competitions at scale.
    index("competitions_institution_id_status_idx").on(table.institutionId, table.status),
    check(
      "competitions_fee_amount_non_negative_chk",
      sql`${table.feeAmount} IS NULL OR ${table.feeAmount} >= 0`,
    ),
    // A stored amount is meaningless without the currency that says what its integer counts, so a
    // competition that charges anything must name one. Zero and NULL are exempt: a free
    // competition has no price to denominate.
    check(
      "competitions_fee_currency_required_chk",
      sql`${table.feeAmount} IS NULL OR ${table.feeAmount} = 0 OR ${table.feeCurrency} IS NOT NULL`,
    ),
    check(
      "competitions_fee_currency_shape_chk",
      sql`${table.feeCurrency} IS NULL OR ${table.feeCurrency} ~ '^[A-Z]{3}$'`,
    ),
    // sql.raw on the bounds is required, not stylistic: a bare `${MIN_PAYMENT_WINDOW_DAYS}` is
    // interpolated as a BIND PARAMETER, and drizzle-kit emits the resulting `$1`/`$2` verbatim
    // into the migration file, where it is not runnable SQL.
    check(
      "competitions_payment_window_days_chk",
      sql`${table.paymentWindowDays} >= ${sql.raw(String(MIN_PAYMENT_WINDOW_DAYS))} AND ${table.paymentWindowDays} <= ${sql.raw(String(MAX_PAYMENT_WINDOW_DAYS))}`,
    ),
    // Cutoff is required (and non-negative) when cancellation is allowed; ignored otherwise.
    check(
      "competitions_cancellation_policy_chk",
      sql`${table.allowCancellation} = false OR (${table.cancellationCutoffDays} IS NOT NULL AND ${table.cancellationCutoffDays} >= 0)`,
    ),
    check(
      "competitions_minimum_participation_non_negative_chk",
      sql`${table.minimumParticipantEntries} IS NULL OR ${table.minimumParticipantEntries} >= 0`,
    ),
    check(
      "competitions_participant_confirmation_order_chk",
      sql`${table.participantConfirmationAt} IS NULL OR ((${table.registrationEndAt} IS NULL OR ${table.registrationEndAt} <= ${table.participantConfirmationAt}) AND (${table.eventStartAt} IS NULL OR ${table.participantConfirmationAt} < ${table.eventStartAt}))`,
    ),
    check(
      "competitions_cancellation_state_chk",
      sql`(${table.cancelledAt} IS NULL AND ${table.cancellationReason} IS NULL) OR (${table.cancelledAt} IS NOT NULL AND ${table.cancellationReason} = 'insufficient_participants' AND ${table.status} = 'published' AND ${table.minimumParticipantEntries} >= 1 AND ${table.participantConfirmationAt} IS NOT NULL AND ${table.eventStartAt} IS NOT NULL AND ${table.cancelledAt} >= ${table.participantConfirmationAt} AND ${table.cancelledAt} < ${table.eventStartAt})`,
    ),
    check(
      "competitions_participation_confirmation_state_chk",
      sql`${table.participationConfirmedAt} IS NULL OR (${table.status} = 'published' AND ${table.minimumParticipantEntries} >= 1 AND ${table.participantConfirmationAt} IS NOT NULL AND ${table.eventStartAt} IS NOT NULL AND ${table.participationConfirmedAt} >= ${table.participantConfirmationAt} AND ${table.participationConfirmedAt} < ${table.eventStartAt} AND ${table.cancelledAt} IS NULL)`,
    ),
    check(
      "competitions_participation_terminal_state_chk",
      sql`${table.cancelledAt} IS NULL OR ${table.participationConfirmedAt} IS NULL`,
    ),
  ],
);

// Structured competition prizes — the "Hadiah" surface on the public detail page. A prize is a
// rank tier with an optional cash amount and/or a certificate. Cash amounts are DISPLAY ONLY:
// no disbursement happens in MVP (payments are Phase 7). Ordered by sort_order for presentation.
export const competitionPrizes = pgTable(
  "competition_prizes",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    competitionId: text("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    rankLabel: text("rank_label"),
    title: text("title").notNull(),
    description: text("description"),
    cashAmount: numeric("cash_amount", { precision: 12, scale: 2 }),
    isCertificate: boolean("is_certificate").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("competition_prizes_competition_id_idx").on(table.competitionId),
    check(
      "competition_prizes_cash_amount_non_negative_chk",
      sql`${table.cashAmount} IS NULL OR ${table.cashAmount} >= 0`,
    ),
  ],
);

// Multi-stage rounds — the "Tahapan & Linimasa" surface on the public detail page. Each round is
// an ordered stage with its own optional date window, description, and platform label (e.g.
// "Online"). When a competition has no rounds the detail page falls back to the flat registration/
// event timeline. Ordered by sort_order for presentation.
export const competitionRounds = pgTable(
  "competition_rounds",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    competitionId: text("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    title: text("title").notNull(),
    description: text("description"),
    startsAt: timestamp("starts_at", { mode: "date", withTimezone: true }),
    endsAt: timestamp("ends_at", { mode: "date", withTimezone: true }),
    platformLabel: text("platform_label"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("competition_rounds_competition_id_idx").on(table.competitionId)],
);

// Additional free-labels on a competition beyond its single primary category. Values are drawn
// from a controlled vocabulary (ALLOWED_COMPETITION_TAGS in competition-tags-core). Composite PK
// enforces one row per (competition, tag).
export const competitionTags = pgTable(
  "competition_tags",
  {
    competitionId: text("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.competitionId, table.tag] }),
    index("competition_tags_competition_id_idx").on(table.competitionId),
  ],
);

// Participant reviews — public rating/feedback on a competition. Moderation axis: a review is
// `visible` by default; platform_ops can flip it to `hidden` (removed from public reads) while
// preserving the row. One review per (competition, author).
export const competitionReviewStatusEnum = pgEnum("competition_review_status", [
  "visible",
  "hidden",
]);

export const competitionReviews = pgTable(
  "competition_reviews",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    competitionId: text("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    body: text("body"),
    status: competitionReviewStatusEnum("status").notNull().default("visible"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("competition_reviews_competition_id_idx").on(table.competitionId),
    uniqueIndex("competition_reviews_competition_author_unique_idx").on(
      table.competitionId,
      table.authorUserId,
    ),
    check(
      "competition_reviews_rating_range_chk",
      sql`${table.rating} >= 1 AND ${table.rating} <= 5`,
    ),
  ],
);

// Student-scoped competition saves.
// Composite PK on (user_id, competition_id) enforces the one-save-per-user-per-competition
// invariant at the DB layer. ON DELETE CASCADE on both FKs — if a user or competition is
// destroyed, saves are cleaned up automatically.
export const competitionSaves = pgTable(
  "competition_saves",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    competitionId: text("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    savedAt: timestamp("saved_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.competitionId] }),
    index("competition_saves_user_id_idx").on(table.userId),
  ],
);

// Competition registration enums.
// `competition_registration_type` distinguishes individual from team registrations.
export const competitionRegistrationTypeEnum = pgEnum("competition_registration_type", [
  "individual",
  "team",
]);

// `competition_registration_status` is the state machine for a registration row.
// `confirmed` is the only initial state in MVP — competitions are free, so registrations skip
// payment. `cancelled` is terminal: cancelled rows cannot transition back to confirmed and
// cannot be re-registered (product simplification).
// Phase 7: pending_payment state — not reachable in MVP. Schema-present so the state machine
// can grow into paid registration without a destructive enum migration.
export const competitionRegistrationStatusEnum = pgEnum("competition_registration_status", [
  "confirmed",
  "cancelled",
  "pending_payment",
]);

// Institution-internal review state on a registration. Distinct from the
// candidate-visible `status` lifecycle above — this value is never exposed through any
// candidate-facing response and never alters `status`. Free transitions between all values
// at MVP (no state-machine guard).
export const competitionRegistrationReviewStatusEnum = pgEnum(
  "competition_registration_review_status",
  ["pending_review", "under_review", "shortlisted", "rejected"],
);

export type CompetitionRegistrationType =
  (typeof competitionRegistrationTypeEnum.enumValues)[number];
export type CompetitionRegistrationStatus =
  (typeof competitionRegistrationStatusEnum.enumValues)[number];
export type CompetitionRegistrationReviewStatus =
  (typeof competitionRegistrationReviewStatusEnum.enumValues)[number];

// Individual competition registration.
// One non-cancelled row per (student_id, competition_id) — enforced by a partial unique index
// in the migration: UNIQUE (student_id, competition_id) WHERE status != 'cancelled'. Cancelled
// rows are retained as historical artefacts and do not block the partial unique; re-registration
// is blocked at the application layer (a confirmed-or-cancelled row makes the student
// "already known" to this competition for the lifetime of MVP).
//
// `team_id` joins a registration row to a `teams` row when registration_type='team'.
// The DB CHECK `competition_registrations_type_team_id_chk` enforces co-presence: a 'team' row
// must carry team_id non-null; an 'individual' row must carry team_id null. The partial unique
// on (student_id, competition_id) WHERE status<>'cancelled' covers both individual and team
// registrations — a candidate cannot hold a confirmed individual registration and a confirmed
// team membership for the same competition simultaneously.
export const competitionRegistrations = pgTable(
  "competition_registrations",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    competitionId: text("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
    registrationType: competitionRegistrationTypeEnum("registration_type")
      .notNull()
      .default("individual"),
    status: competitionRegistrationStatusEnum("status").notNull().default("confirmed"),
    registeredAt: timestamp("registered_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    cancelledAt: timestamp("cancelled_at", { mode: "date", withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    // Institution-internal review — not candidate-visible.
    internalReviewStatus: competitionRegistrationReviewStatusEnum("internal_review_status")
      .notNull()
      .default("pending_review"),
    internalNotes: text("internal_notes"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("competition_registrations_competition_id_idx").on(table.competitionId),
    index("competition_registrations_student_id_idx").on(table.studentId),
    index("competition_registrations_team_id_idx").on(table.teamId),
    // Partial unique index — see migration for the WHERE clause. Drizzle expresses this via the
    // `where` option on uniqueIndex.
    uniqueIndex("competition_registrations_student_competition_active_unique_idx")
      .on(table.studentId, table.competitionId)
      .where(sql`${table.status} <> 'cancelled'`),
    // Co-presence invariant: registration_type and team_id must agree.
    check(
      "competition_registrations_type_team_id_chk",
      sql`(${table.registrationType} = 'team' AND ${table.teamId} IS NOT NULL) OR (${table.registrationType} = 'individual' AND ${table.teamId} IS NULL)`,
    ),
    // A registration's team must belong to the SAME competition the registration does. The two
    // single-column foreign keys above each hold on their own while the pair is nonsense — a row
    // pointing at this competition and at a team from a different one satisfies both. That pairing
    // is what the payment group is derived from, so a mismatched pair puts one competition's
    // registrations into another competition's payment.
    //
    // MATCH SIMPLE (the default) is what makes this correct for individual registrations: with
    // team_id NULL the constraint is satisfied without a referenced row, so nothing here forces a
    // team onto a registration that has none.
    foreignKey({
      columns: [table.competitionId, table.teamId],
      foreignColumns: [teams.competitionId, teams.id],
      name: "competition_registrations_competition_team_fk",
    }).onDelete("cascade"),
  ],
);

// Participant document verification.
//
// An organizer asks ONE named participant for ONE named document by a named date. The request
// hangs off a single competition_registrations row, so a team of four is four independent
// requests — proof of personal status is personal, and nobody hands their ID card to their
// captain. This is the deliberate opposite of updateRegistrationReview, which fans a review
// verdict out across every row sharing a team_id.
//
// A request is orthogonal to participation: it never gates registration, submission, results, or
// the participant count. It is also independent of competition phase — an organizer may ask
// during registration, mid-competition, or after results are published.
//
// `unfulfilled` is deliberately NOT a value here. A lapsed request is derived
// (status = 'requested' AND due_at < now()), so no scheduled job is needed to keep the column
// honest and the state can never drift from the clock.
export const registrationDocumentRequestStatusEnum = pgEnum(
  "registration_document_request_status",
  ["requested", "submitted", "accepted", "rejected", "cancelled"],
);

export type RegistrationDocumentRequestStatus =
  (typeof registrationDocumentRequestStatusEnum.enumValues)[number];

export const competitionDocumentRequests = pgTable(
  "competition_document_requests",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    registrationId: text("registration_id").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions"),
    dueAt: timestamp("due_at", { mode: "date", withTimezone: true }).notNull(),
    status: registrationDocumentRequestStatusEnum("status").notNull().default("requested"),
    requestedByUserId: text("requested_by_user_id"),
    // Stamped when the first file finalizes. Compared against due_at to mark a late response;
    // a late upload is still accepted, because nothing about a request blocks the candidate.
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true }),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }),
    // Reason for the most recent rejection. Retained when a rejection reopens the request for a
    // re-upload, so the candidate keeps seeing what was wrong with the previous attempt.
    reviewNote: text("review_note"),
    // Counts rejections, not uploads, so a later reviewer can tell a first attempt from a third.
    revisionCount: integer("revision_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Foreign keys are named explicitly. Drizzle's auto-generated names concatenate both table
    // names and would run to 77-81 characters here, past Postgres's 63-character identifier
    // limit, where they are silently truncated on creation and then diverge from this file.
    foreignKey({
      columns: [table.registrationId],
      foreignColumns: [competitionRegistrations.id],
      name: "competition_document_requests_registration_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.requestedByUserId],
      foreignColumns: [users.id],
      name: "competition_document_requests_requested_by_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.reviewedByUserId],
      foreignColumns: [users.id],
      name: "competition_document_requests_reviewed_by_fk",
    }).onDelete("set null"),
    index("competition_document_requests_registration_id_idx").on(table.registrationId),
    // At most one OPEN request per participant, where open means awaiting an upload or awaiting a
    // verdict. Closed rows are unaffected, which is what lets an organizer raise a fresh request
    // months later — after results, for instance.
    uniqueIndex("competition_document_requests_open_unique_idx")
      .on(table.registrationId)
      .where(sql`${table.status} in ('requested', 'submitted')`),
  ],
);

// Files attached to a document request. Mirrors recruiter_verification_documents: the row is
// written only after the stored object's real size and magic-byte type have been inspected, so a
// row here always describes bytes that exist and are of an accepted type.
export const competitionDocumentRequestFiles = pgTable(
  "competition_document_request_files",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    requestId: text("request_id").notNull(),
    r2Key: text("r2_key").notNull(),
    originalFileName: text("original_file_name").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [competitionDocumentRequests.id],
      name: "competition_document_request_files_request_id_fk",
    }).onDelete("cascade"),
    index("competition_document_request_files_request_id_idx").on(table.requestId),
  ],
);

export type CompetitionDocumentRequestRecord = typeof competitionDocumentRequests.$inferSelect;
export type CompetitionDocumentRequestFileRecord =
  typeof competitionDocumentRequestFiles.$inferSelect;

// Candidate onboarding profile.
// Captured when an account first declares the candidate role, in the same transaction that grants
// candidate verification. These are self-declared descriptive fields, not an eligibility gate:
// there is no age or enrollment restriction on becoming a candidate. Separate from user_profiles
// because these fields are candidate-specific and are not exposed via the generic profile shell
// endpoint. `full_name` is the candidate's own declared full name, distinct from the profile
// display name. Every field is required; the profile is one uniform shape with no conditional
// fields.
export const candidateProfiles = pgTable("candidate_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  phoneNumber: text("phone_number").notNull(),
  occupation: candidateOccupationEnum("occupation").notNull(),
  dateOfBirth: date("date_of_birth", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});

// Team lifecycle enums + tables.
// `team_status` is the team-level lifecycle: `forming`, `submitted` (the team has registered
// for a competition), and `cancelled`.
export const teamStatusEnum = pgEnum("team_status", ["forming", "submitted", "cancelled"]);

// `team_membership_role` distinguishes the captain seat from regular member seats. Captain
// counts toward the size total just like any other seat.
export const teamMembershipRoleEnum = pgEnum("team_membership_role", ["captain", "member"]);

// `team_membership_status` is the per-member lifecycle. `removed` is terminal — a removed row
// is retained as a historical artefact and does not block re-invitation (the partial unique
// index filters it out).
export const teamMembershipStatusEnum = pgEnum("team_membership_status", ["active", "removed"]);

// `team_invitation_status` mirrors the institution_invitation_status shape but excludes
// `expired` as an explicit terminal — expired invitations are detected at accept-time against
// the row's expires_at column and transitioned to `cancelled` (operationally equivalent for
// MVP).
export const teamInvitationStatusEnum = pgEnum("team_invitation_status", [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  // Parallels institution_invitation_status.pending_claim: invited email has no
  // account yet (target_user_id IS NULL), inbox-invisible, claimed at verified signup → `pending`.
  "pending_claim",
]);

export type TeamStatus = (typeof teamStatusEnum.enumValues)[number];
export type TeamMembershipRole = (typeof teamMembershipRoleEnum.enumValues)[number];
export type TeamMembershipStatus = (typeof teamMembershipStatusEnum.enumValues)[number];
export type TeamInvitationStatus = (typeof teamInvitationStatusEnum.enumValues)[number];

// Team entity. Captain is tracked via a FK to users on the team row (for fast lookup
// and disambiguation), and also via a team_memberships row with role=captain inserted in the
// same transaction as team creation. The two views must stay consistent — the team_memberships
// row is the source of truth for the roster.
export const teams = pgTable(
  "teams",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    competitionId: text("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    captainId: text("captain_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: teamStatusEnum("status").notNull().default("forming"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("teams_competition_id_name_unique_idx").on(table.competitionId, table.name),
    index("teams_competition_id_idx").on(table.competitionId),
    index("teams_captain_id_idx").on(table.captainId),
    // Redundant on its own — `id` is already the primary key — and required by Postgres so that
    // competition_registrations can carry a composite foreign key on (competition_id, team_id). A
    // referenced column list must be backed by a unique constraint, so the pair needs its own.
    uniqueIndex("teams_competition_id_id_unique_idx").on(table.competitionId, table.id),
  ],
);

// Team membership roster row. Captain holds a row with role=captain inserted in the
// same transaction as the team. Members accept invitations to land here.
// One active row per (team_id, user_id) — enforced by a partial unique index in the migration.
// Removed rows are retained but excluded from the unique scope.
// A candidate's at-most-one-active-membership-per-competition invariant is enforced at the
// service layer (the partial unique covers only the per-team scope).
export const teamMemberships = pgTable(
  "team_memberships",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: teamMembershipRoleEnum("role").notNull(),
    status: teamMembershipStatusEnum("status").notNull().default("active"),
    joinedAt: timestamp("joined_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("team_memberships_team_id_idx").on(table.teamId),
    index("team_memberships_user_id_idx").on(table.userId),
    uniqueIndex("team_memberships_team_user_active_unique_idx")
      .on(table.teamId, table.userId)
      .where(sql`${table.status} = 'active'`),
  ],
);

// Team invitation. SHA-256 token hash pattern mirrors institution_invitations.
// Raw token is generated in memory, emailed via Resend, and discarded — only the hash is
// persisted. invited_email is normalized to lowercase on insert.
export const teamInvitations = pgTable(
  "team_invitations",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    invitedEmail: text("invited_email").notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    tokenHash: text("token_hash").notNull(),
    status: teamInvitationStatusEnum("status").notNull().default("pending"),
    // Recipient resolution for the in-app inbox. Mirrors institution_invitations:
    // backfilled (migration 0027) from invited_email, ON DELETE SET NULL, inbox queries by
    // target_user_id only. See the institution_invitations.target_user_id note above.
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("team_invitations_token_hash_unique_idx").on(table.tokenHash),
    index("team_invitations_team_id_idx").on(table.teamId),
    index("team_invitations_status_idx").on(table.status),
    index("team_invitations_target_user_id_idx").on(table.targetUserId),
  ],
);

// Competition submission intake.
// One submission row per registration — enforced by a UNIQUE constraint on registration_id at
// the DB layer (not just application-layer). Replace semantics: a candidate may overwrite their
// submission (incrementing `version`) until they finalize it; `finalized_at` non-null locks the
// row. The finalized guard lives in the DB WHERE clause of the replace upsert and the finalize
// UPDATE — a read-before-write check is not sufficient under concurrency.
// Only file metadata is stored. The file itself lives in Cloudflare R2, addressed by `file_key`.
// We do not verify the object exists in R2 — key-prefix validation (submissions/{registrationId}/)
// is the MVP security boundary. Download (presigned GET) is deferred to a later step.
export const competitionSubmissions = pgTable(
  "competition_submissions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    registrationId: text("registration_id")
      .notNull()
      .references(() => competitionRegistrations.id, { onDelete: "cascade" }),
    submittedById: text("submitted_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fileKey: text("file_key").notNull(),
    fileName: text("file_name").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    fileMimeType: text("file_mime_type"),
    version: integer("version").notNull().default(1),
    finalizedAt: timestamp("finalized_at", { mode: "date", withTimezone: true }),
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Exactly one submission per registration — the one-active-submission invariant.
    uniqueIndex("competition_submissions_registration_id_unique_idx").on(table.registrationId),
    index("competition_submissions_submitted_by_id_idx").on(table.submittedById),
  ],
);

export type SubmissionRecord = typeof competitionSubmissions.$inferSelect;

// Competition result publication.
// One result row per registration — UNIQUE on registration_id. Result state is either draft
// (institution-internal, not visible to candidate) or published (visible to candidate as
// result_label + result_notes only). published_at must be null when draft — enforced by a
// DB CHECK constraint. Publishing one team member's registration publishes all member rows
// for the same team_id + competition_id atomically.
export const competitionResultStatusEnum = pgEnum("competition_result_status", [
  "draft",
  "published",
]);

export type CompetitionResultStatus = (typeof competitionResultStatusEnum.enumValues)[number];

export const competitionResults = pgTable(
  "competition_results",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    registrationId: text("registration_id")
      .notNull()
      .references(() => competitionRegistrations.id, { onDelete: "cascade" }),
    competitionId: text("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    resultStatus: competitionResultStatusEnum("result_status").notNull().default("draft"),
    resultLabel: text("result_label"),
    resultNotes: text("result_notes"),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("competition_results_registration_id_unique_idx").on(table.registrationId),
    index("competition_results_competition_id_status_idx").on(
      table.competitionId,
      table.resultStatus,
    ),
    check(
      "competition_results_published_at_status_chk",
      sql`${table.publishedAt} IS NULL OR ${table.resultStatus} = 'published'`,
    ),
  ],
);

export type CompetitionResultRecord = typeof competitionResults.$inferSelect;

// In-app notification storage (the dual-channel half of DEC-0076: every
// participant-facing event fires a Resend email AND writes a row here). This PostgreSQL table
// shares the name `notifications` with the BullMQ queue of the same name — they are different
// systems in different runtimes; the collision is intentional and must not be renamed.
// `type` is stored as free text (validated against the NotificationType union at the application
// layer) so new event types can ship without an enum migration.
export const notifications = pgTable(
  "notifications",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    readAt: timestamp("read_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Inbox listing: per-user newest-first.
    index("notifications_user_id_created_at_idx").on(table.userId, table.createdAt.desc()),
    // Unread count: partial index over only the unread rows per user.
    index("notifications_user_id_unread_idx")
      .on(table.userId)
      .where(sql`${table.readAt} IS NULL`),
  ],
);

export type NotificationRecord = typeof notifications.$inferSelect;

// Institution document verification submission system.
// An institution owner submits identity documents to platform ops for review. On approval,
// verification_status transitions to verified; on upgrade (personal → full), the type flip and
// display_name persistence happen in the same transaction.
// `draft` is used by recruiter verification only: a submission the applicant has withdrawn from
// the review queue in order to revise it. Institution verification never writes it.
export const verificationSubmissionStatusEnum = pgEnum("verification_submission_status", [
  "draft",
  "pending_review",
  "approved",
  "rejected",
]);

export type VerificationSubmissionStatus =
  (typeof verificationSubmissionStatusEnum.enumValues)[number];

export const institutionVerificationSubmissions = pgTable(
  "institution_verification_submissions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    submittedByUserId: text("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    targetInstitutionType: institutionTypeEnum("target_institution_type").notNull(),
    proposedDisplayName: text("proposed_display_name"),
    status: verificationSubmissionStatusEnum("status").notNull().default("pending_review"),
    // For university and campus_organization submissions only: true = institutional domain
    // (e.g. @unpad.ac.id), false = known personal-provider domain (e.g. @gmail.com). NULL for
    // all other institution types.
    emailDomainFlag: boolean("email_domain_flag"),
    reviewerUserId: text("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewerNotes: text("reviewer_notes"),
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    index("institution_verification_submissions_institution_id_status_idx").on(
      table.institutionId,
      table.status,
    ),
    // At most one queued submission per institution. Institution verification never writes
    // `draft` (recruiter-only), so unlike the recruiter-side equivalent this only needs to cover
    // `pending_review`. Belt-and-braces alongside the pg_advisory_xact_lock in
    // acquireInstitutionSubmissionLock — confirmed zero pre-existing duplicates against the live
    // DB before adding this (INST-VERIF-D1).
    uniqueIndex("institution_verification_submissions_pending_unique_idx")
      .on(table.institutionId)
      .where(sql`${table.status} = 'pending_review'`),
  ],
);

export const institutionVerificationDocuments = pgTable(
  "institution_verification_documents",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    submissionId: text("submission_id")
      .notNull()
      .references(() => institutionVerificationSubmissions.id, { onDelete: "cascade" }),
    documentType: text("document_type").notNull(),
    r2Key: text("r2_key").notNull(),
    originalFileName: text("original_file_name").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("institution_verification_documents_submission_id_idx").on(table.submissionId)],
);

// Recruiter trust verification — a recruiter account submits a lightweight affiliation form
// (full name, mobile number, optional corporate email, optional proof documents) reviewed by
// platform ops. Approval elevates users.recruiter_verification_tier to `elevated` ("Trusted
// Recruiter"), which gates competition publishing and full-institution creation. The three
// priority signals (vouched_at, email_domain_flag, document presence) order the review queue
// only — human review is always the gate.
export const recruiterVerificationSubmissions = pgTable(
  "recruiter_verification_submissions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    mobileNumber: text("mobile_number").notNull(),
    // Optional declared work email — may differ from the login email. Ownership is NOT proven
    // at MVP; it informs email_domain_flag and admin cross-checking only.
    corporateEmail: text("corporate_email"),
    // true = corporate_email uses a non-personal-provider domain, false = known personal
    // provider (e.g. @gmail.com), NULL = no corporate email declared.
    emailDomainFlag: boolean("email_domain_flag"),
    // Set when the submitter accepts an owner/staff invitation from an institution that has a
    // Trusted (elevated-tier) owner — the strongest queue-priority signal.
    vouchedAt: timestamp("vouched_at", { mode: "date", withTimezone: true }),
    status: verificationSubmissionStatusEnum("status").notNull().default("pending_review"),
    reviewerUserId: text("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    // Reason for the most recent rejection. Retained across a reopen so the reviewer of a
    // resubmission can see what the previous verdict objected to.
    rejectionReason: text("rejection_reason"),
    // Whether the recruiter may reopen this submission after a rejection. Set by the reviewer at
    // rejection time and reversible from the platform-ops queue.
    resubmissionAllowed: boolean("resubmission_allowed").notNull().default(true),
    // How many times the recruiter has reopened this submission after a rejection. 0 = the account
    // has never been rejected; the review queue reads it to distinguish a first application from a
    // resubmission.
    resubmissionCount: integer("resubmission_count").notNull().default(0),
    // When this account FIRST entered the review queue. Written once at creation and never
    // touched again — this is what the queue orders by, so revising and resending does not cost
    // the applicant their place in line.
    firstSubmittedAt: timestamp("first_submitted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    // When the submission was most recently sent for review. Bumped on every withdraw-resubmit and
    // every reopen-after-rejection, so a reviewer can see how fresh the current attempt is. It does
    // NOT affect queue order.
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    index("recruiter_verification_submissions_user_id_idx").on(table.userId),
    // At most one OPEN submission per account, where open means awaiting review or withdrawn for
    // revision. Covering both prevents an account holding a draft and a queued submission at once.
    // rejected/approved history rows are unaffected.
    uniqueIndex("recruiter_verification_submissions_user_pending_unique_idx")
      .on(table.userId)
      .where(sql`${table.status} in ('draft', 'pending_review')`),
    // Review-queue scan: only pending rows, ordered by submission time.
    index("recruiter_verification_submissions_pending_submitted_idx")
      .on(table.submittedAt)
      .where(sql`${table.status} = 'pending_review'`),
  ],
);

// Optional affiliation-proof files attached to a recruiter verification submission. Free-form
// evidence (employment letter, staff ID, etc.) — no per-type requirements; original_file_name
// is the reviewer-facing label.
export const recruiterVerificationDocuments = pgTable(
  "recruiter_verification_documents",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    submissionId: text("submission_id")
      .notNull()
      .references(() => recruiterVerificationSubmissions.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    originalFileName: text("original_file_name").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("recruiter_verification_documents_submission_id_idx").on(table.submissionId)],
);

export type RecruiterVerificationSubmissionRecord =
  typeof recruiterVerificationSubmissions.$inferSelect;
export type RecruiterVerificationDocumentRecord =
  typeof recruiterVerificationDocuments.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Finance domain.
//
// THE PLATFORM NEVER CUSTODIES FUNDS (DEC-0130). A payer pays into the institution's own gateway
// sub-account and the platform fee splits at transaction time, so no Lombakita-controlled balance
// ever exists. Every row below answers "what happened", never "what does the platform hold" —
// there is deliberately no balance table, no payout-owed table, and no unclaimed-funds concept,
// and no column here may ever acquire that meaning.
//
// THE LEDGER IS APPEND-ONLY (DEC-0133). `finance_payment_events` rows are INSERTed and never
// UPDATEd or DELETEd; a correction is a compensating event and a refund is a reversing event.
// Enforced at the service layer, following the house convention of `platform_ops_audit_logs` and
// `institution_audit_logs` — no database triggers or rules, which this codebase uses nowhere.
//
// MONEY IS INTEGER MINOR UNITS, always paired with an ISO-4217 currency. `bigint` rather than
// `integer`: a realistic IDR gross approaches the 32-bit ceiling (int4 tops out at 2,147,483,647,
// which is only Rp 2,1 miliar), and a silent overflow in a financial column is unrecoverable.
// Read as JS `number` (mode: "number"), safe to 2^53 ≈ Rp 9 quadriliun. The exponent convention
// is documented once, in `@/lib/finance/money`.
// ---------------------------------------------------------------------------------------------

export const financePaymentSubjectEnum = pgEnum("finance_payment_subject", PAYMENT_SUBJECT_TYPES);

export const financePaymentEventTypeEnum = pgEnum("finance_payment_event_type", PAYMENT_EVENT_TYPES);

export const financePaymentEventActorEnum = pgEnum(
  "finance_payment_event_actor",
  PAYMENT_EVENT_ACTOR_TYPES,
);

export const financePaymentOriginEnum = pgEnum("finance_payment_origin", PAYMENT_ORIGINS);

export const financeFeeAccrualEntryEnum = pgEnum(
  "finance_fee_accrual_entry",
  FEE_ACCRUAL_ENTRY_TYPES,
);

export const financeManualProofStatusEnum = pgEnum(
  "finance_manual_proof_status",
  MANUAL_PAYMENT_PROOF_STATUSES,
);

// Effective-dated platform fee rules. `institution_id` NULL is the global default; a non-null row
// overrides it for that institution over its own effective window.
//
// Rows are configuration, not money — but a payment snapshots the terms it was priced under and
// keeps a provenance pointer here, so a rule that has priced anything must survive. Hence NO ACTION
// (no cascade, no set-null) on every finance foreign key: the delete is refused, and nothing in
// this domain disappears because a neighbouring row did.
export const financeFeeRules = pgTable(
  "finance_fee_rules",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    // NULL = the platform-wide default rule.
    institutionId: text("institution_id").references(() => institutions.id),
    currency: text("currency").notNull(),
    // Proportional component, 1/100th of a percent. 250 = 2,5%.
    basisPoints: integer("basis_points").notNull().default(0),
    // Fixed component in minor units, charged on top of the proportional one.
    flatAmount: bigint("flat_amount", { mode: "number" }).notNull().default(0),
    minimumFeeAmount: bigint("minimum_fee_amount", { mode: "number" }),
    maximumFeeAmount: bigint("maximum_fee_amount", { mode: "number" }),
    effectiveFrom: timestamp("effective_from", { mode: "date", withTimezone: true }).notNull(),
    // NULL = open-ended.
    effectiveTo: timestamp("effective_to", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("finance_fee_rules_scope_effective_idx").on(table.institutionId, table.effectiveFrom),
    check("finance_fee_rules_currency_chk", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      "finance_fee_rules_basis_points_chk",
      sql`${table.basisPoints} >= 0 AND ${table.basisPoints} <= 10000`,
    ),
    check("finance_fee_rules_flat_amount_chk", sql`${table.flatAmount} >= 0`),
    check(
      "finance_fee_rules_bounds_chk",
      sql`(${table.minimumFeeAmount} IS NULL OR ${table.minimumFeeAmount} >= 0) AND (${table.maximumFeeAmount} IS NULL OR ${table.maximumFeeAmount} >= 0) AND (${table.minimumFeeAmount} IS NULL OR ${table.maximumFeeAmount} IS NULL OR ${table.minimumFeeAmount} <= ${table.maximumFeeAmount})`,
    ),
    check(
      "finance_fee_rules_window_chk",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
);

// One row per payment. Immutable after creation — it carries no status column (state is folded
// from `finance_payment_events`) and nothing in the service layer updates it.
//
// `receiving_institution_id` is NOT NULL by design (DEC-0130): a payment that cannot name who
// receives the money is a payment the platform would implicitly be holding, which is the exact
// concept this schema must be unable to express.
//
// THE FEE SNAPSHOT IS STRUCTURAL, NOT AN ADD-ON. `fee_basis_points`, `fee_flat_amount`,
// `platform_fee_amount`, `institution_net_amount`, `gross_amount` and `currency` are written at
// creation and never recomputed. Changing a fee rule next month must not restate what a payment
// recorded last month; `fee_rule_id` records only WHICH rule priced it, and is never re-read to
// derive a figure.
export const financePayments = pgTable(
  "finance_payments",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    payerUserId: text("payer_user_id").notNull(),
    receivingInstitutionId: text("receiving_institution_id").notNull(),
    // Which lane carried the money. NOT NULL with NO DEFAULT, deliberately: a default would let a
    // future insert that forgot to declare its lane land silently as whichever value was chosen
    // here, and the fee columns mean different things per lane. Every caller states it.
    origin: financePaymentOriginEnum("origin").notNull(),
    subjectType: financePaymentSubjectEnum("subject_type").notNull(),
    // One nullable real foreign key per subject type. A new subject type adds its own column
    // here and widens the XOR CHECK below in the same migration.
    competitionRegistrationId: text("competition_registration_id"),
    currency: text("currency").notNull(),
    grossAmount: bigint("gross_amount", { mode: "number" }).notNull(),
    // --- fee snapshot ---
    feeRuleId: text("fee_rule_id").notNull(),
    feeBasisPoints: integer("fee_basis_points").notNull(),
    feeFlatAmount: bigint("fee_flat_amount", { mode: "number" }).notNull(),
    platformFeeAmount: bigint("platform_fee_amount", { mode: "number" }).notNull(),
    institutionNetAmount: bigint("institution_net_amount", { mode: "number" }).notNull(),
    // THE DEADLINE THIS PAYMENT WAS GIVEN, snapshotted at creation from the competition's window
    // and never recomputed. Editing the window does not reach back — that is the entire reason
    // this is a column rather than a join. Required on the manual lane (CHECK below) and null on
    // the gateway lane, where the provider owns expiry.
    dueAt: timestamp("due_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Foreign keys are named explicitly: Drizzle's generated names concatenate both table names
    // and would exceed Postgres's 63-character identifier limit here, where they truncate silently
    // and then diverge from this file.
    foreignKey({
      columns: [table.payerUserId],
      foreignColumns: [users.id],
      name: "finance_payments_payer_user_id_fk",
    }),
    foreignKey({
      columns: [table.receivingInstitutionId],
      foreignColumns: [institutions.id],
      name: "finance_payments_receiving_institution_id_fk",
    }),
    foreignKey({
      columns: [table.competitionRegistrationId],
      foreignColumns: [competitionRegistrations.id],
      name: "finance_payments_competition_registration_id_fk",
    }),
    foreignKey({
      columns: [table.feeRuleId],
      foreignColumns: [financeFeeRules.id],
      name: "finance_payments_fee_rule_id_fk",
    }),
    index("finance_payments_receiving_institution_id_idx").on(table.receivingInstitutionId),
    index("finance_payments_payer_user_id_idx").on(table.payerUserId),
    // NOT unique, deliberately. Capping a registration to one live payment is a cross-row count
    // race whose correct mechanism is the per-owner advisory lock convention (DEC-0099), and whose
    // semantics — what counts as live, and what a second attempt after a failure means — belong to
    // the checkout flow that will own them. Duplicate payments per registration are unconstrained
    // until then; half-building the cap here would look like a guard without being one.
    index("finance_payments_competition_registration_id_idx").on(table.competitionRegistrationId),
    // Exactly one subject key, agreeing with subject_type. One arm per subject type today; adding
    // a subject adds its own arm, which must assert its key non-null AND every other subject key
    // null.
    check(
      "finance_payments_subject_xor_chk",
      sql`(${table.subjectType} = 'competition_registration' AND ${table.competitionRegistrationId} IS NOT NULL)`,
    ),
    check("finance_payments_currency_chk", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("finance_payments_gross_amount_chk", sql`${table.grossAmount} >= 0`),
    check(
      "finance_payments_fee_snapshot_chk",
      sql`${table.feeBasisPoints} >= 0 AND ${table.feeBasisPoints} <= 10000 AND ${table.feeFlatAmount} >= 0 AND ${table.platformFeeAmount} >= 0 AND ${table.institutionNetAmount} >= 0`,
    ),
    // The split has to add up, in the database, forever. A fee larger than the gross would mean an
    // institution owing money on a sale it made.
    check(
      "finance_payments_split_balance_chk",
      sql`${table.platformFeeAmount} + ${table.institutionNetAmount} = ${table.grossAmount}`,
    ),
    // THE MANUAL LANE SPLITS NOTHING. The fee columns on this table mean "what moved apart at
    // transaction time"; on a manual transfer the payer sent the whole amount straight to the
    // institution's own account, so the truthful record is a zero platform fee and a net equal to
    // gross. The platform's fee on that payment is a SEPARATE debt, recorded in
    // finance_fee_accruals. Without this CHECK the same columns would quietly carry two different
    // meanings depending on origin, which is how a reconciliation ends up double-counting a fee.
    check(
      "finance_payments_manual_lane_no_split_chk",
      sql`${table.origin} <> 'manual_transfer' OR (${table.platformFeeAmount} = 0 AND ${table.institutionNetAmount} = ${table.grossAmount})`,
    ),
    // A manual payment without a deadline never lapses, so an expiry sweep would step over it
    // forever and the payment would sit pending indefinitely.
    check(
      "finance_payments_manual_due_at_chk",
      sql`${table.origin} <> 'manual_transfer' OR ${table.dueAt} IS NOT NULL`,
    ),
  ],
);

// WHAT AN INSTITUTION OWES THE PLATFORM on a manual-lane payment. Append-only (DEC-0133): a
// correction is a compensating `reversed` row, never an edit.
//
// THIS IS NOT A BALANCE TABLE AND MUST NOT BECOME ONE. DEC-0130 forbids the platform recording
// what it HOLDS on someone else's behalf — money owed TO an institution, custodied by us. This
// table records the OPPOSITE DIRECTION: a fee the institution owes US, on money it already
// received directly and that never touched a platform-controlled account. The two are not
// symmetric and collapsing them would be wrong in both directions.
//
// Concretely, so a later reader does not "clean this up":
//   - Do NOT delete this table as a DEC-0130 violation. It is not one.
//   - Do NOT generalise it into one by adding a column meaning "owed to the institution", a
//     running balance, a settled/unsettled flag pair used as a wallet, or a netting column. A
//     statement or an invoice is DERIVED by summing these rows; it is never stored here.
//
// One accrual per payment is a DATABASE guarantee (partial unique index on the `accrued` arm),
// not a service read-then-write, because the write races: the platform idempotency arm mints a
// fresh UUID per call by design, so two clicks produce two `succeeded` events. The fold tolerates
// that; a doubled fee does not.
export const financeFeeAccruals = pgTable(
  "finance_fee_accruals",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    paymentId: text("payment_id").notNull(),
    // Who owes it. Denormalised from the payment deliberately: this is the axis every statement
    // groups by, and re-deriving it through a join would make the owing institution a property of
    // a row that can be read without it.
    owingInstitutionId: text("owing_institution_id").notNull(),
    entryType: financeFeeAccrualEntryEnum("entry_type").notNull(),
    currency: text("currency").notNull(),
    // Signed. Positive on `accrued`, non-positive on `reversed` — a compensating row has no other
    // way to express itself in a table with no update path.
    amount: bigint("amount", { mode: "number" }).notNull(),
    // --- the rule snapshot, mirroring finance_payments and never recomputed ---
    // `fee_rule_id` records only WHICH rule priced this accrual. Every figure that matters is
    // copied here, so editing a rule next month cannot restate what was accrued last month.
    feeRuleId: text("fee_rule_id").notNull(),
    feeBasisPoints: integer("fee_basis_points").notNull(),
    feeFlatAmount: bigint("fee_flat_amount", { mode: "number" }).notNull(),
    // The gross the fee was computed against, so a row is auditable without reading the payment.
    grossAmount: bigint("gross_amount", { mode: "number" }).notNull(),
    // Mandatory on `reversed` (CHECK below): a fee walked back without a stated why is the one
    // thing an auditor cannot reconstruct later.
    reason: text("reason"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.paymentId],
      foreignColumns: [financePayments.id],
      name: "finance_fee_accruals_payment_id_fk",
    }),
    foreignKey({
      columns: [table.owingInstitutionId],
      foreignColumns: [institutions.id],
      name: "finance_fee_accruals_owing_institution_id_fk",
    }),
    foreignKey({
      columns: [table.feeRuleId],
      foreignColumns: [financeFeeRules.id],
      name: "finance_fee_accruals_fee_rule_id_fk",
    }),
    // EXACTLY ONE accrual per payment, enforced by Postgres rather than by a service that reads
    // first and writes second.
    uniqueIndex("finance_fee_accruals_payment_accrued_unique_idx")
      .on(table.paymentId)
      .where(sql`${table.entryType} = 'accrued'`),
    // EXACTLY ONE reversal per payment, for a reason that is about direction rather than tidiness.
    // A reversal negates the accrued amount exactly, so with both arms capped at one row the signed
    // SUM of a payment's rows can only be the fee or zero. Leaving this arm unbounded lets repeated
    // reversals drive that sum NEGATIVE, and a negative total reads as the platform owing the
    // institution money — the custody direction DEC-0130 forbids the platform to be in at all.
    //
    // The cost is real and accepted: a fee is now charge-once, reverse-once, terminal. Correcting a
    // reversal is not expressible and would need a decision about what a second correction means
    // before it could be, which is a better place to be than a table that can silently go negative.
    uniqueIndex("finance_fee_accruals_payment_reversed_unique_idx")
      .on(table.paymentId)
      .where(sql`${table.entryType} = 'reversed'`),
    index("finance_fee_accruals_owing_institution_id_idx").on(table.owingInstitutionId),
    check("finance_fee_accruals_currency_chk", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      "finance_fee_accruals_amount_sign_chk",
      sql`(${table.entryType} = 'accrued' AND ${table.amount} >= 0) OR (${table.entryType} = 'reversed' AND ${table.amount} <= 0)`,
    ),
    check(
      "finance_fee_accruals_reason_required_chk",
      sql`${table.entryType} <> 'reversed' OR (${table.reason} IS NOT NULL AND btrim(${table.reason}) <> '')`,
    ),
    check(
      "finance_fee_accruals_fee_snapshot_chk",
      sql`${table.feeBasisPoints} >= 0 AND ${table.feeBasisPoints} <= 10000 AND ${table.feeFlatAmount} >= 0 AND ${table.grossAmount} >= 0`,
    ),
  ],
);

// The bukti transfer: a candidate's evidence that they sent the money, and the organiser's review
// of it. ONE row per payment, reopened in place through the DEC-0115 revision loop rather than
// stacked as new rows, so `rejection_reason` survives the reopen and the reviewer of attempt two
// can read what attempt one was refused for.
//
// NOT part of the append-only ledger, and deliberately so. This row carries a REVIEW STATUS that
// transitions (pending_review → verified / rejected → pending_review …); the money facts live in
// finance_payments and finance_payment_events, which do not move. Its status changes are the one
// mutation in the finance domain, made through an optimistic CAS on the status column.
//
// RETENTION: a bukti transfer is FINANCIAL EVIDENCE AND IS NEVER PURGED, at any age. The
// competition-scoped retention sweep must never reach it — see the assertion in
// finance-retention-exclusion.test.ts, which fails if the sweep's purge surface ever names this
// table or its object prefix.
export const financeManualPaymentProofs = pgTable(
  "finance_manual_payment_proofs",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    paymentId: text("payment_id").notNull(),
    // Scope carried on the row so every organiser-side read filters in the query rather than
    // trusting the caller to filter afterwards.
    competitionId: text("competition_id").notNull(),
    submittedByUserId: text("submitted_by_user_id").notNull(),
    status: financeManualProofStatusEnum("status").notNull().default("pending_review"),
    // --- file metadata, the DEC-0125/0126 hardened shape ---
    r2Key: text("r2_key").notNull(),
    originalFileName: text("original_file_name").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    reviewerUserId: text("reviewer_user_id"),
    // Retained across a reopen, never cleared on resubmission.
    rejectionReason: text("rejection_reason"),
    // Whether the candidate may resubmit after a rejection. ORGANISER-CONTROLLED, default allowed,
    // and enforced in the reopen CAS rather than by hiding a control — a bar that only exists in
    // the UI is not a bar.
    resubmissionAllowed: boolean("resubmission_allowed").notNull().default(true),
    resubmissionCount: integer("resubmission_count").notNull().default(0),
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.paymentId],
      foreignColumns: [financePayments.id],
      name: "finance_manual_payment_proofs_payment_id_fk",
    }),
    foreignKey({
      columns: [table.competitionId],
      foreignColumns: [competitions.id],
      name: "finance_manual_payment_proofs_competition_id_fk",
    }),
    foreignKey({
      columns: [table.submittedByUserId],
      foreignColumns: [users.id],
      name: "finance_manual_payment_proofs_submitted_by_user_id_fk",
    }),
    foreignKey({
      columns: [table.reviewerUserId],
      foreignColumns: [users.id],
      name: "finance_manual_payment_proofs_reviewer_user_id_fk",
    }),
    // One proof per payment. The revision loop reopens THIS row; it never inserts a second.
    uniqueIndex("finance_manual_payment_proofs_payment_unique_idx").on(table.paymentId),
    // Serves the payment-in-flight predicate and the organiser review queue in one shape.
    index("finance_manual_payment_proofs_competition_status_idx").on(
      table.competitionId,
      table.status,
    ),
    check(
      "finance_manual_payment_proofs_rejection_reason_chk",
      sql`${table.status} <> 'rejected' OR (${table.rejectionReason} IS NOT NULL AND btrim(${table.rejectionReason}) <> '')`,
    ),
    check(
      "finance_manual_payment_proofs_reviewed_chk",
      sql`${table.status} IN ('pending_review') OR ${table.reviewedAt} IS NOT NULL`,
    ),
    check("finance_manual_payment_proofs_file_size_chk", sql`${table.fileSizeBytes} > 0`),
    check(
      "finance_manual_payment_proofs_resubmission_count_chk",
      sql`${table.resubmissionCount} >= 0`,
    ),
  ],
);

// Where an institution wants to be paid on the manual lane. INSTITUTION-LEVEL and reused across
// every competition it runs — there is deliberately no per-competition override, because an
// organiser maintaining N copies of one bank account is how a stale account number ends up
// collecting nobody's money.
//
// The platform never holds these funds (DEC-0130); this is the institution's own account, shown
// to a payer so they can transfer to it directly.
export const institutionPaymentInstructions = pgTable(
  "institution_payment_instructions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    institutionId: text("institution_id").notNull(),
    bankName: text("bank_name"),
    accountNumber: text("account_number"),
    accountHolderName: text("account_holder_name"),
    // R2 key of an uploaded QRIS image, when the institution offers one.
    qrisR2Key: text("qris_r2_key"),
    // Free-text notes shown alongside the account details ("cantumkan nama tim di berita acara").
    instructionsNote: text("instructions_note"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Named explicitly for the same reason the finance foreign keys are: Drizzle's generated name
    // concatenates both table names and lands at 66 characters here, which Postgres truncates
    // silently at 63 — leaving the live constraint name permanently different from the one this
    // file appears to declare.
    foreignKey({
      columns: [table.institutionId],
      foreignColumns: [institutions.id],
      name: "institution_payment_instructions_institution_id_fk",
    }).onDelete("cascade"),
    uniqueIndex("institution_payment_instructions_institution_unique_idx").on(table.institutionId),
    // A row that names neither a bank account nor a QRIS tells a payer nothing, so it must not
    // exist — an institution with no instructions has no row, which is a state the reader already
    // handles. A bank account needs all three parts to be usable.
    check(
      "institution_payment_instructions_payable_chk",
      sql`${table.qrisR2Key} IS NOT NULL OR (${table.bankName} IS NOT NULL AND ${table.accountNumber} IS NOT NULL AND ${table.accountHolderName} IS NOT NULL)`,
    ),
  ],
);

// The append-only ledger. INSERT ONLY: no service function updates or deletes a row here, and a
// test asserts that no such function exists. The payment FK carries no ON DELETE action, so
// deleting a payment that has events is refused and an event can never be orphaned.
export const financePaymentEvents = pgTable(
  "finance_payment_events",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    paymentId: text("payment_id").notNull(),
    eventType: financePaymentEventTypeEnum("event_type").notNull(),
    // When it happened, per the source of truth (a gateway callback carries its own instant).
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).notNull(),
    // When we wrote it down. Distinct from occurred_at because the gap between the two is itself
    // diagnostic — a webhook replayed hours late is a different situation from one handled live.
    recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    // Monetary events carry both; non-monetary events carry neither (CHECK enforces the pairing).
    amount: bigint("amount", { mode: "number" }),
    currency: text("currency"),
    actorType: financePaymentEventActorEnum("actor_type").notNull(),
    actorUserId: text("actor_user_id"),
    // Required for the two event types that restate already-recorded money.
    reason: text("reason"),
    metadata: jsonb("metadata"),
    // The replay guard, enforced by the unique index below — NOT by a read-then-insert check,
    // which cannot close the race it appears to close.
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.paymentId],
      foreignColumns: [financePayments.id],
      name: "finance_payment_events_payment_id_fk",
    }),
    foreignKey({
      columns: [table.actorUserId],
      foreignColumns: [users.id],
      name: "finance_payment_events_actor_user_id_fk",
    }),
    uniqueIndex("finance_payment_events_idempotency_key_idx").on(table.idempotencyKey),
    // The fold's read path: every event for one payment, in canonical order.
    index("finance_payment_events_payment_occurred_idx").on(table.paymentId, table.occurredAt),
    check(
      "finance_payment_events_amount_currency_chk",
      sql`(${table.amount} IS NULL AND ${table.currency} IS NULL) OR (${table.amount} IS NOT NULL AND ${table.currency} IS NOT NULL AND ${table.currency} ~ '^[A-Z]{3}$')`,
    ),
    // Only a correction may be negative — it is the only way an append-only table can walk back an
    // over-recorded figure.
    check(
      "finance_payment_events_amount_sign_chk",
      sql`${table.amount} IS NULL OR ${table.amount} >= 0 OR ${table.eventType} = 'corrected'`,
    ),
    check(
      "finance_payment_events_reason_required_chk",
      sql`${table.eventType} NOT IN ('refunded', 'corrected') OR (${table.reason} IS NOT NULL AND btrim(${table.reason}) <> '')`,
    ),
    // A named human is required for, and only for, a 'user' event.
    check(
      "finance_payment_events_actor_chk",
      sql`(${table.actorType} = 'user' AND ${table.actorUserId} IS NOT NULL) OR (${table.actorType} <> 'user' AND ${table.actorUserId} IS NULL)`,
    ),
  ],
);

export type FinanceFeeRuleRecord = typeof financeFeeRules.$inferSelect;
export type FinancePaymentRecord = typeof financePayments.$inferSelect;
export type FinancePaymentEventRecord = typeof financePaymentEvents.$inferSelect;
export type FinanceFeeAccrualRecord = typeof financeFeeAccruals.$inferSelect;
export type FinanceManualPaymentProofRecord = typeof financeManualPaymentProofs.$inferSelect;
export type InstitutionPaymentInstructionsRecord =
  typeof institutionPaymentInstructions.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Platform-ops MFA. One verified TOTP factor per account and its ten
// single-use recovery codes. `platform_ops` / `finance_ops` sign in through the existing
// providers unchanged; this is the SECOND gate, checked at the two authorization choke points
// (`assertSessionRole`, `requireRolePage`), never per-route.
// ---------------------------------------------------------------------------------------------

// One row per account, at most. `verified_at` is NULL for a factor mid-enrolment (the operator has
// scanned the QR but not yet confirmed a code) and non-null once confirmed — the row is created at
// the START of enrolment so the one-factor-per-user unique index can refuse a second concurrent
// enrolment attempt, not only a second confirmed factor. The secret is AES-256-GCM at rest
// (`mfa-encryption.ts`); `secret_iv` and `secret_auth_tag` are stored alongside the ciphertext
// because GCM needs both to decrypt and to prove the ciphertext was not tampered with.
// `last_used_step` is the replay guard: a code valid inside its own 30s window must not be
// accepted twice, so a successful verification never accepts a step at or below this one.
// `failed_attempt_count` / `locked_until` are shared between a TOTP challenge and a recovery-code
// attempt against the SAME factor — both are "prove you are the operator" attempts, and a database
// counter (not the fail-open Redis limiter) is what makes lockout hold during a Redis outage.
export const mfaFactors = pgTable(
  "mfa_factors",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    encryptedSecret: text("encrypted_secret").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretAuthTag: text("secret_auth_tag").notNull(),
    verifiedAt: timestamp("verified_at", { mode: "date", withTimezone: true }),
    lastUsedStep: bigint("last_used_step", { mode: "number" }),
    failedAttemptCount: integer("failed_attempt_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("mfa_factors_user_id_unique_idx").on(table.userId),
    check("mfa_factors_failed_attempt_count_chk", sql`${table.failedAttemptCount} >= 0`),
  ],
);

// Ten single-use codes minted when enrolment is CONFIRMED (not at QR-display time — an abandoned
// enrolment never gets codes it cannot use). Looked up by hash, not by a slow KDF: a recovery code
// is high-entropy (128+ bits) and generated by us, not chosen by a human, so there is no low-entropy
// guessing surface a bcrypt-class hash would be defending against — a plain SHA-256 lookup index is
// both correct and O(1). `code_hash` is globally unique (not scoped to user_id) purely because the
// codes are drawn from a large random space and a collision would only ever indicate a generation
// bug worth surfacing loudly rather than silently overwriting.
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("mfa_recovery_codes_user_id_idx").on(table.userId),
    uniqueIndex("mfa_recovery_codes_code_hash_unique_idx").on(table.codeHash),
  ],
);

export type MfaFactorRecord = typeof mfaFactors.$inferSelect;
export type MfaRecoveryCodeRecord = typeof mfaRecoveryCodes.$inferSelect;

// Non-domain bootstrap table for validating migration workflow only.
export const infrastructureProbe = pgTable("infrastructure_probe", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
