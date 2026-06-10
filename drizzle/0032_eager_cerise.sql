CREATE TYPE "public"."verification_submission_status" AS ENUM('pending_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "institution_verification_documents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"submission_id" text NOT NULL,
	"document_type" text NOT NULL,
	"r2_key" text NOT NULL,
	"original_file_name" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institution_verification_submissions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"institution_id" text NOT NULL,
	"submitted_by_user_id" text,
	"target_institution_type" "institution_type" NOT NULL,
	"proposed_display_name" text,
	"status" "verification_submission_status" DEFAULT 'pending_review' NOT NULL,
	"email_domain_flag" boolean,
	"reviewer_user_id" text,
	"reviewer_notes" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "institution_verification_documents" ADD CONSTRAINT "institution_verification_documents_submission_id_institution_verification_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."institution_verification_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_verification_submissions" ADD CONSTRAINT "institution_verification_submissions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_verification_submissions" ADD CONSTRAINT "institution_verification_submissions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_verification_submissions" ADD CONSTRAINT "institution_verification_submissions_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "institution_verification_submissions_institution_id_status_idx" ON "institution_verification_submissions" USING btree ("institution_id","status");--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_display_name_type_chk" CHECK ("institutions"."institution_type" = 'personal' OR "institutions"."display_name" IS NOT NULL);