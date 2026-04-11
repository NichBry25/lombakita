CREATE TYPE "public"."app_user_status" AS ENUM('active', 'suspended', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."institution_membership_role" AS ENUM('institution_admin', 'institution_staff', 'reviewer_or_judge');--> statement-breakpoint
CREATE TYPE "public"."institution_membership_status" AS ENUM('invited', 'active', 'inactive', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."institution_status" AS ENUM('active', 'inactive', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."platform_user_role" AS ENUM('student', 'platform_ops', 'finance_ops');--> statement-breakpoint
CREATE TABLE "institution_memberships" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"institution_id" text NOT NULL,
	"user_id" text NOT NULL,
	"membership_role" "institution_membership_role" NOT NULL,
	"status" "institution_membership_status" DEFAULT 'active' NOT NULL,
	"invited_by_user_id" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "institution_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_platform_roles" (
	"user_id" text NOT NULL,
	"role" "platform_user_role" NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_platform_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "app_user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "institution_memberships" ADD CONSTRAINT "institution_memberships_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_memberships" ADD CONSTRAINT "institution_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_memberships" ADD CONSTRAINT "institution_memberships_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_platform_roles" ADD CONSTRAINT "user_platform_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "institution_membership_institution_user_unique_idx" ON "institution_memberships" USING btree ("institution_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "institutions_slug_unique_idx" ON "institutions" USING btree ("slug");