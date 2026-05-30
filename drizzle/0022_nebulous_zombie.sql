CREATE TABLE "competition_submissions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"registration_id" text NOT NULL,
	"submitted_by_id" text NOT NULL,
	"file_key" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size_bytes" bigint,
	"file_mime_type" text,
	"version" integer DEFAULT 1 NOT NULL,
	"finalized_at" timestamp with time zone,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competition_submissions" ADD CONSTRAINT "competition_submissions_registration_id_competition_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."competition_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_submissions" ADD CONSTRAINT "competition_submissions_submitted_by_id_users_id_fk" FOREIGN KEY ("submitted_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_submissions_registration_id_unique_idx" ON "competition_submissions" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "competition_submissions_submitted_by_id_idx" ON "competition_submissions" USING btree ("submitted_by_id");