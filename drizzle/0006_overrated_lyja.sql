CREATE TYPE "public"."institution_invitation_status" AS ENUM('pending', 'accepted', 'declined', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "institution_invitations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"institution_id" text NOT NULL,
	"invited_email" text NOT NULL,
	"invited_role" "institution_membership_role" NOT NULL,
	"token_hash" text NOT NULL,
	"status" "institution_invitation_status" DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institution_invitations" ADD CONSTRAINT "institution_invitations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_invitations" ADD CONSTRAINT "institution_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "institution_invitations_token_hash_unique_idx" ON "institution_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "institution_invitations_institution_id_idx" ON "institution_invitations" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "institution_invitations_status_idx" ON "institution_invitations" USING btree ("status");