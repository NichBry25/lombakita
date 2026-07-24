CREATE TYPE "public"."profile_social_platform" AS ENUM('linkedin', 'github', 'instagram', 'x', 'website');--> statement-breakpoint
CREATE TABLE "profile_certifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"issue_date" date,
	"expiry_date" date,
	"credential_id" text,
	"credential_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_educations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"school" text NOT NULL,
	"degree" text,
	"field_of_study" text,
	"start_year" integer,
	"end_year" integer,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_educations_year_order_chk" CHECK ("profile_educations"."start_year" IS NULL OR "profile_educations"."end_year" IS NULL OR "profile_educations"."end_year" >= "profile_educations"."start_year")
);
--> statement-breakpoint
CREATE TABLE "profile_experiences" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"organization_name" text NOT NULL,
	"location" text,
	"start_date" date,
	"end_date" date,
	"is_current" boolean DEFAULT false NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_experiences_date_order_chk" CHECK ("profile_experiences"."start_date" IS NULL OR "profile_experiences"."end_date" IS NULL OR "profile_experiences"."end_date" >= "profile_experiences"."start_date"),
	CONSTRAINT "profile_experiences_current_no_end_chk" CHECK ("profile_experiences"."is_current" = false OR "profile_experiences"."end_date" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "profile_skills" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_social_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"platform" "profile_social_platform" NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_certifications" ADD CONSTRAINT "profile_certifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_educations" ADD CONSTRAINT "profile_educations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_experiences" ADD CONSTRAINT "profile_experiences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_skills" ADD CONSTRAINT "profile_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_social_links" ADD CONSTRAINT "profile_social_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_certifications_user_id_idx" ON "profile_certifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "profile_educations_user_id_idx" ON "profile_educations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "profile_experiences_user_id_idx" ON "profile_experiences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "profile_skills_user_id_idx" ON "profile_skills" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_skills_user_name_unique_idx" ON "profile_skills" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "profile_social_links_user_id_idx" ON "profile_social_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_social_links_user_platform_unique_idx" ON "profile_social_links" USING btree ("user_id","platform");--> statement-breakpoint
INSERT INTO "profile_educations" ("user_id", "school", "field_of_study", "end_year") SELECT "user_id", "university", "major", "graduation_year" FROM "user_profiles" WHERE "university" IS NOT NULL;--> statement-breakpoint
INSERT INTO "profile_experiences" ("user_id", "title", "organization_name") SELECT "user_id", "role_title", "organization_name" FROM "user_profiles" WHERE "role_title" IS NOT NULL AND "organization_name" IS NOT NULL;--> statement-breakpoint
INSERT INTO "profile_social_links" ("user_id", "platform", "url") SELECT "user_id", 'website', "website_url" FROM "user_profiles" WHERE "website_url" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "university";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "major";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "graduation_year";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "role_title";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "organization_name";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "website_url";