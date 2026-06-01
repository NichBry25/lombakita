CREATE TYPE "public"."competition_result_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "competition_results" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"registration_id" text NOT NULL,
	"competition_id" text NOT NULL,
	"result_status" "competition_result_status" DEFAULT 'draft' NOT NULL,
	"result_label" text,
	"result_notes" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_results_published_at_status_chk" CHECK ("competition_results"."published_at" IS NULL OR "competition_results"."result_status" = 'published')
);
--> statement-breakpoint
ALTER TABLE "competition_results" ADD CONSTRAINT "competition_results_registration_id_competition_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."competition_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_results" ADD CONSTRAINT "competition_results_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_results_registration_id_unique_idx" ON "competition_results" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "competition_results_competition_id_status_idx" ON "competition_results" USING btree ("competition_id","result_status");