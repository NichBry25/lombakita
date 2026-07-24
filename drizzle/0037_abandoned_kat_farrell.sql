CREATE TABLE "recruiter_verification_documents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"submission_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"original_file_name" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recruiter_verification_submissions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"full_name" text NOT NULL,
	"mobile_number" text NOT NULL,
	"corporate_email" text,
	"email_domain_flag" boolean,
	"vouched_at" timestamp with time zone,
	"status" "verification_submission_status" DEFAULT 'pending_review' NOT NULL,
	"reviewer_user_id" text,
	"rejection_reason" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "recruiter_verification_documents" ADD CONSTRAINT "recruiter_verification_documents_submission_id_recruiter_verification_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."recruiter_verification_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_verification_submissions" ADD CONSTRAINT "recruiter_verification_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_verification_submissions" ADD CONSTRAINT "recruiter_verification_submissions_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recruiter_verification_documents_submission_id_idx" ON "recruiter_verification_documents" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "recruiter_verification_submissions_user_id_idx" ON "recruiter_verification_submissions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recruiter_verification_submissions_user_pending_unique_idx" ON "recruiter_verification_submissions" USING btree ("user_id") WHERE "recruiter_verification_submissions"."status" = 'pending_review';--> statement-breakpoint
CREATE INDEX "recruiter_verification_submissions_pending_submitted_idx" ON "recruiter_verification_submissions" USING btree ("submitted_at") WHERE "recruiter_verification_submissions"."status" = 'pending_review';--> statement-breakpoint
UPDATE "users" SET "recruiter_verification_tier" = 'elevated' WHERE "recruiter_verified_at" IS NOT NULL AND "recruiter_verification_tier" <> 'elevated';