import { sql } from "drizzle-orm";
import {
  integer,
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

export const platformUserRoleEnum = pgEnum("platform_user_role", [
  "student",
  "platform_ops",
  "finance_ops",
]);

export const institutionStatusEnum = pgEnum("institution_status", [
  "active",
  "inactive",
  "suspended",
]);

export const institutionMembershipRoleEnum = pgEnum("institution_membership_role", [
  "institution_admin",
  "institution_staff",
  "reviewer_or_judge",
]);

export const institutionMembershipStatusEnum = pgEnum("institution_membership_status", [
  "invited",
  "active",
  "inactive",
  "revoked",
]);

export type InstitutionMembershipRole = (typeof institutionMembershipRoleEnum.enumValues)[number];
export type InstitutionMembershipStatus =
  (typeof institutionMembershipStatusEnum.enumValues)[number];
export type InstitutionStatus = (typeof institutionStatusEnum.enumValues)[number];
export type PlatformUserRole = (typeof platformUserRoleEnum.enumValues)[number];

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { mode: "date", withTimezone: true }),
  image: text("image"),
  role: appRoleEnum("role").notNull().default(DEFAULT_APP_ROLE),
  status: appUserStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});

export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  summary: text("summary"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});

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

// Non-domain bootstrap table for validating migration workflow only.
export const infrastructureProbe = pgTable("infrastructure_probe", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
