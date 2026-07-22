ALTER TABLE "profile_certifications" ADD COLUMN "file_r2_key" text;--> statement-breakpoint
ALTER TABLE "profile_certifications" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "profile_certifications" ADD COLUMN "file_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "profile_certifications" ADD COLUMN "file_mime_type" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "avatar_r2_key" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "resume_r2_key" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "resume_file_name" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "resume_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "resume_mime_type" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "resume_uploaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "resume_public" boolean DEFAULT false NOT NULL;