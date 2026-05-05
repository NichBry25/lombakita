CREATE TYPE "public"."competition_mode" AS ENUM('individual', 'team', 'both');--> statement-breakpoint
CREATE TYPE "public"."competition_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"institution_id" text NOT NULL,
	"created_by_user_id" text,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "competition_status" DEFAULT 'draft' NOT NULL,
	"category" text,
	"mode" "competition_mode",
	"min_team_size" integer,
	"max_team_size" integer,
	"registration_start_at" timestamp with time zone,
	"registration_end_at" timestamp with time zone,
	"event_start_at" timestamp with time zone,
	"event_end_at" timestamp with time zone,
	"fee_amount" numeric(12, 2),
	"fee_currency" text,
	"is_featured" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitions_fee_amount_non_negative_chk" CHECK ("competitions"."fee_amount" IS NULL OR "competitions"."fee_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitions_institution_id_slug_unique_idx" ON "competitions" USING btree ("institution_id","slug");--> statement-breakpoint
CREATE INDEX "competitions_institution_id_idx" ON "competitions" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "competitions_status_idx" ON "competitions" USING btree ("status");