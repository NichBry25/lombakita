CREATE TYPE "public"."competition_report_status" AS ENUM('open', 'closed', 'actioned');--> statement-breakpoint
CREATE TYPE "public"."institution_tick_path" AS ENUM('domain', 'instagram', 'documents', 'staff');--> statement-breakpoint
CREATE TABLE "competition_reports" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"competition_id" text NOT NULL,
	"reporter_user_id" text,
	"reason" text NOT NULL,
	"note" text,
	"status" "competition_report_status" DEFAULT 'open' NOT NULL,
	"guideline_item" text,
	"handled_by_user_id" text,
	"handled_at" timestamp with time zone,
	"handling_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_reports_reason_chk" CHECK ("competition_reports"."reason" IN ('penipuan', 'informasi_palsu', 'konten_tidak_pantas', 'lainnya')),
	CONSTRAINT "competition_reports_note_required_chk" CHECK ("competition_reports"."reason" <> 'lainnya' OR "competition_reports"."note" IS NOT NULL),
	CONSTRAINT "competition_reports_handled_pair_chk" CHECK (("competition_reports"."status" = 'open') = ("competition_reports"."handled_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "host_organization_emails" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"domain" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_organization_emails_email_normalized_chk" CHECK ("host_organization_emails"."email" = lower(btrim("host_organization_emails"."email"))),
	CONSTRAINT "host_organization_emails_email_domain_chk" CHECK ("host_organization_emails"."email" LIKE ('%@' || "host_organization_emails"."domain"))
);
--> statement-breakpoint
CREATE TABLE "organization_email_challenges" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_email_challenges_failed_attempts_chk" CHECK ("organization_email_challenges"."failed_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "competitions" DROP CONSTRAINT "competitions_cancellation_state_chk";--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "frozen_reason" text;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "frozen_by_user_id" text;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "date_check_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "tick_path" "institution_tick_path";--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "tick_domain" text;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "name_proof_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "name_proof_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recruiter_verification_submissions" ADD COLUMN "competition_id" text;--> statement-breakpoint
ALTER TABLE "recruiter_verification_submissions" ADD COLUMN "guideline_item" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "host_trust_removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competition_reports" ADD CONSTRAINT "competition_reports_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_reports" ADD CONSTRAINT "competition_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_reports" ADD CONSTRAINT "competition_reports_handled_by_user_id_users_id_fk" FOREIGN KEY ("handled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_organization_emails" ADD CONSTRAINT "host_organization_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_email_challenges" ADD CONSTRAINT "organization_email_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_reports_competition_id_reporter_user_id_unique_idx" ON "competition_reports" USING btree ("competition_id","reporter_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "host_organization_emails_email_unique_idx" ON "host_organization_emails" USING btree ("email");--> statement-breakpoint
CREATE INDEX "organization_email_challenges_email_created_at_idx" ON "organization_email_challenges" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "organization_email_challenges_user_id_created_at_idx" ON "organization_email_challenges" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_frozen_by_user_id_users_id_fk" FOREIGN KEY ("frozen_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_verification_submissions" ADD CONSTRAINT "recruiter_verification_submissions_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_frozen_pair_chk" CHECK (("competitions"."frozen_at" IS NULL) = ("competitions"."frozen_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_cancellation_state_chk" CHECK (("competitions"."cancelled_at" IS NULL AND "competitions"."cancellation_reason" IS NULL) OR ("competitions"."cancelled_at" IS NOT NULL AND "competitions"."cancellation_reason" = 'insufficient_participants' AND "competitions"."status" = 'published' AND "competitions"."minimum_participant_entries" >= 1 AND "competitions"."participant_confirmation_at" IS NOT NULL AND "competitions"."event_start_at" IS NOT NULL AND "competitions"."cancelled_at" >= "competitions"."participant_confirmation_at" AND "competitions"."cancelled_at" < "competitions"."event_start_at") OR ("competitions"."cancelled_at" IS NOT NULL AND "competitions"."cancellation_reason" = 'fraud'));