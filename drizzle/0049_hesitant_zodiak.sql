ALTER TABLE "recruiter_verification_submissions" ADD COLUMN "first_submitted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "recruiter_verification_submissions" SET "first_submitted_at" = "submitted_at" WHERE "first_submitted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "recruiter_verification_submissions" ALTER COLUMN "first_submitted_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "recruiter_verification_submissions" ALTER COLUMN "first_submitted_at" SET NOT NULL;
