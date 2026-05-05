CREATE TYPE "public"."institution_verification_status" AS ENUM('pending_verification', 'under_review', 'verified', 'rejected');--> statement-breakpoint
CREATE TABLE "institution_verification_audit" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"institution_id" text NOT NULL,
	"actor_user_id" text,
	"from_status" "institution_verification_status" NOT NULL,
	"to_status" "institution_verification_status" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "verification_status" "institution_verification_status" DEFAULT 'pending_verification' NOT NULL;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "institution_verification_audit" ADD CONSTRAINT "institution_verification_audit_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_verification_audit" ADD CONSTRAINT "institution_verification_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "institution_verification_audit_institution_id_idx" ON "institution_verification_audit" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "institution_verification_audit_created_at_idx" ON "institution_verification_audit" USING btree ("created_at");