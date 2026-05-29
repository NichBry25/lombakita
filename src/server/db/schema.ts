import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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

export const appRoleEnum = pgEnum("app_role", APP_ROLES);

export const appUserStatusEnum = pgEnum("app_user_status", ["active", "suspended", "deactivated"]);

// Rollback Step 1.3 — platform_user_role is the auxiliary user-platform-roles table enum.
// The `student` token is renamed to `candidate` in lockstep with appRoleEnum (CCR-01).
// `recruiter` is intentionally NOT added here yet — recruiter-side platform-role wiring is
// Step 1.4 / Step 4.0c territory; the current consumers only need parity with the primary role
// values that can also appear as elevated platform roles (platform_ops, finance_ops).
export const platformUserRoleEnum = pgEnum("platform_user_role", [
  "candidate",
  "platform_ops",
  "finance_ops",
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
]);

// Step 4.0c (CCR-19 / DEC-0053) — Recruiter verification tier.
// Per-account tier dimension that refines the recruiter role's capability surface. Auto-granted
// to `minimal` at recruiter signup; only `platform_ops` can lift an account to `elevated` (manual
// review at launch — mechanical verification flow deferred per CCR-19). Tier is monotonically
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

export type RecruiterVerificationTier =
  (typeof recruiterVerificationTierEnum.enumValues)[number];

export const competitionStatusEnum = pgEnum("competition_status", [
  "draft",
  "published",
  "archived",
]);

export const competitionModeEnum = pgEnum("competition_mode", ["individual", "team", "both"]);

// Step 3.2: competition_category enum. Curated MVP set; extension in later phases must align
// with the contract's category taxonomy. "other" is the safety-valve value.
export const competitionCategoryEnum = pgEnum("competition_category", [
  "technology",
  "science",
  "business",
  "creative_arts",
  "social_humanities",
  "sports",
  "academic",
  "other",
]);

export type CompetitionMode = (typeof competitionModeEnum.enumValues)[number];
export type CompetitionStatus = (typeof competitionStatusEnum.enumValues)[number];
export type CompetitionCategory = (typeof competitionCategoryEnum.enumValues)[number];

// Step 4.1: Student eligibility primitives.
// `student_enrollment_status` is the self-declared MVP enrollment value. `enrolled` is the only
// status that satisfies the eligibility helper; other values produce ineligible_enrollment.
// `unknown` is the safety-valve until the student fills the field.
export const studentEnrollmentStatusEnum = pgEnum("student_enrollment_status", [
  "enrolled",
  "on_leave",
  "graduated",
  "unknown",
]);

// Indonesian higher-education credential levels. D3/D4 are diploma tracks; S1/S2/S3 are
// undergraduate, master, doctoral. Curated MVP set; extension deferred to a later step.
export const studentEducationLevelEnum = pgEnum("student_education_level", [
  "D3",
  "D4",
  "S1",
  "S2",
  "S3",
]);

export type StudentEnrollmentStatus = (typeof studentEnrollmentStatusEnum.enumValues)[number];
export type StudentEducationLevel = (typeof studentEducationLevelEnum.enumValues)[number];

export type AppUserStatus = (typeof appUserStatusEnum.enumValues)[number];
export type InstitutionInvitationStatus =
  (typeof institutionInvitationStatusEnum.enumValues)[number];
export type InstitutionMembershipRole = (typeof institutionMembershipRoleEnum.enumValues)[number];
export type InstitutionMembershipStatus =
  (typeof institutionMembershipStatusEnum.enumValues)[number];
export type InstitutionStatus = (typeof institutionStatusEnum.enumValues)[number];
export type InstitutionVerificationStatus =
  (typeof institutionVerificationStatusEnum.enumValues)[number];
export type PlatformUserRole = (typeof platformUserRoleEnum.enumValues)[number];

// Rollback Step 1.3 — per-role verification persistence (CCR-02 / DEC-0036).
// `candidateVerifiedAt` and `recruiterVerifiedAt` independently record whether each user-level
// role mode has been verified for this account. Every account must hold at least one non-null
// timestamp — enforced by a DB-level CHECK constraint (`users_one_verified_role_chk`) so the
// invariant survives any code path that creates or modifies user rows. Tier refinement for the
// recruiter mode (CCR-19) ships at Step 4.0c; the schema only carries the per-mode timestamp
// today.
//
// Step 2.1 (re-execution) — `username` added as the canonical public URL handle for the user
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
    // Step 4.0c (CCR-19 / DEC-0053) — recruiter tier dimension. Placed on `users` (not a
    // parallel table) so it sits adjacent to the per-role verification timestamps and shares
    // their lifecycle. Non-null with default `unverified`; recruiter signup writes `minimal`
    // atomically alongside `recruiterVerifiedAt`. See `assertRecruiterTier` for the read path.
    recruiterVerificationTier: recruiterVerificationTierEnum("recruiter_verification_tier")
      .notNull()
      .default("unverified"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("users_username_unique_idx").on(table.username),
    check(
      "users_one_verified_role_chk",
      sql`${table.candidateVerifiedAt} IS NOT NULL OR ${table.recruiterVerifiedAt} IS NOT NULL`,
    ),
    // Step 4.0c (Sch4.0c-M2) — recruiter tier consistency invariant. Any row holding a non-null
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

// Step 2.1 (re-execution) — Profile shell rebuild.
// `summary` column is kept as-is (closing the rename debt is deferred: see CURRENT_STATE.md
// known debt). The new user-profile API exposes it as `bio`. Old student-profile code continues
// to reference it as `summary` → `headline` without disruption.
// `phoneNumber` retained for backward compat with pre-rollback student-profile code.
// New fields added:
//   shared:           location
//   candidate-scoped: university, major, graduation_year
//   recruiter-scoped: role_title, organization_name, website_url
// Field scope (shared / candidate / recruiter) is enforced at the application layer only — no
// DB-level scope column. The scope constants live in src/server/user-profile/profile-core.ts.
export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  phoneNumber: text("phone_number"),
  avatarUrl: text("avatar_url"),
  summary: text("summary"),
  location: text("location"),
  university: text("university"),
  major: text("major"),
  graduationYear: integer("graduation_year"),
  roleTitle: text("role_title"),
  organizationName: text("organization_name"),
  websiteUrl: text("website_url"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});

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
    displayName: text("display_name").notNull(),
    slug: text("slug").notNull(),
    status: institutionStatusEnum("status").notNull().default("active"),
    verificationStatus: institutionVerificationStatusEnum("verification_status")
      .notNull()
      .default("pending_verification"),
    verifiedAt: timestamp("verified_at", { mode: "date", withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { mode: "date", withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("institutions_slug_unique_idx").on(table.slug)],
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
// on (institution_id, user_id) from step 2.2 — no additional constraint needed here.
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
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("institution_invitations_token_hash_unique_idx").on(table.tokenHash),
    index("institution_invitations_institution_id_idx").on(table.institutionId),
    index("institution_invitations_status_idx").on(table.status),
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

// Step 3.1: Competition domain model.
// Slug uniqueness is institution-scoped — UNIQUE (institution_id, slug). Two institutions may
// reuse the same human-readable slug (e.g. "hackathon-2026") without collision.
// Deletion model: drafts soft-delete via deleted_at. Published and archived records are not
// deletable through DELETE — published must transition to archived first; archived is terminal.
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
    feeAmount: numeric("fee_amount", { precision: 12, scale: 2 }),
    feeCurrency: text("fee_currency"),
    isFeatured: boolean("is_featured").notNull().default(false),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
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
  ],
);

// Step 3.6: Student-scoped competition saves.
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

// Step 4.2: Competition registration enums.
// `competition_registration_type` distinguishes individual from team registrations. Step 4.2
// only writes `individual`; `team` is reserved for Steps 4.3/4.4.
export const competitionRegistrationTypeEnum = pgEnum("competition_registration_type", [
  "individual",
  "team",
]);

// `competition_registration_status` is the state machine for a registration row.
// `confirmed` is the only initial state in MVP — competitions are free, so registrations skip
// payment. `cancelled` is terminal: cancelled rows cannot transition back to confirmed and
// cannot be re-registered (Step 4.2 product simplification).
// Phase 7: pending_payment state — not reachable in MVP. Schema-present so the state machine
// can grow into paid registration without a destructive enum migration.
export const competitionRegistrationStatusEnum = pgEnum("competition_registration_status", [
  "confirmed",
  "cancelled",
  "pending_payment",
]);

export type CompetitionRegistrationType =
  (typeof competitionRegistrationTypeEnum.enumValues)[number];
export type CompetitionRegistrationStatus =
  (typeof competitionRegistrationStatusEnum.enumValues)[number];

// Step 4.2: Individual competition registration.
// One non-cancelled row per (student_id, competition_id) — enforced by a partial unique index
// in the migration: UNIQUE (student_id, competition_id) WHERE status != 'cancelled'. Cancelled
// rows are retained as historical artefacts and do not block the partial unique; re-registration
// is blocked at the application layer (a confirmed-or-cancelled row makes the student
// "already known" to this competition for the lifetime of MVP).
//
// Step 4.4: `team_id` joins a registration row to a `teams` row when registration_type='team'.
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
    // Step 4.4 — co-presence invariant: registration_type and team_id must agree.
    check(
      "competition_registrations_type_team_id_chk",
      sql`(${table.registrationType} = 'team' AND ${table.teamId} IS NOT NULL) OR (${table.registrationType} = 'individual' AND ${table.teamId} IS NULL)`,
    ),
  ],
);

// Step 4.1: Student eligibility profile.
// Eligibility STATUS is never persisted — it is computed on demand by checkStudentEligibility
// from the fields below plus the current server time. This table stores only the raw inputs the
// student self-declares; the helper is the single source of truth for the derived status.
// Separate from user_profiles because eligibility is student-only and must not be exposed via
// the generic profile shell endpoint (see contract: forbidden_mutation_scopes).
export const studentEligibilityProfiles = pgTable("student_eligibility_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  enrollmentStatus: studentEnrollmentStatusEnum("enrollment_status"),
  educationLevel: studentEducationLevelEnum("education_level"),
  universityName: text("university_name"),
  studentIdNumber: text("student_id_number"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});

// Step 4.3: Team lifecycle enums + tables.
// `team_status` is the team-level lifecycle. Step 4.3 writes only `forming` and `cancelled`.
// `submitted` is reserved for Step 4.4 (team registration submission) — schema-present so the
// state machine can grow without a destructive enum migration.
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
]);

export type TeamStatus = (typeof teamStatusEnum.enumValues)[number];
export type TeamMembershipRole = (typeof teamMembershipRoleEnum.enumValues)[number];
export type TeamMembershipStatus = (typeof teamMembershipStatusEnum.enumValues)[number];
export type TeamInvitationStatus = (typeof teamInvitationStatusEnum.enumValues)[number];

// Step 4.3 — Team entity. Captain is tracked via a FK to users on the team row (for fast lookup
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
  ],
);

// Step 4.3 — Team membership roster row. Captain holds a row with role=captain inserted in the
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

// Step 4.3 — Team invitation. SHA-256 token hash pattern mirrors institution_invitations.
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
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("team_invitations_token_hash_unique_idx").on(table.tokenHash),
    index("team_invitations_team_id_idx").on(table.teamId),
    index("team_invitations_status_idx").on(table.status),
  ],
);

// Non-domain bootstrap table for validating migration workflow only.
export const infrastructureProbe = pgTable("infrastructure_probe", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
