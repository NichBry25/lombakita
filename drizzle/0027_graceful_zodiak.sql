CREATE TABLE "notifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institution_invitations" ADD COLUMN "target_user_id" text;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "target_user_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_user_id_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
ALTER TABLE "institution_invitations" ADD CONSTRAINT "institution_invitations_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "institution_invitations_target_user_id_idx" ON "institution_invitations" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "team_invitations_target_user_id_idx" ON "team_invitations" USING btree ("target_user_id");--> statement-breakpoint
-- Step 6.5.1 backfill (hand-authored; drizzle-kit does not generate data migrations).
-- Resolve target_user_id for invitations that are still actionable at migration time:
-- pending status AND not yet expired. Case-insensitive email match against existing users.
-- Invitations addressed to an email with no account remain NULL (claimed at signup in Step 6.5e).
UPDATE "institution_invitations" AS ii
SET "target_user_id" = u."id"
FROM "users" AS u
WHERE lower(ii."invited_email") = lower(u."email")
  AND ii."status" = 'pending'
  AND ii."expires_at" > now();--> statement-breakpoint
UPDATE "team_invitations" AS ti
SET "target_user_id" = u."id"
FROM "users" AS u
WHERE lower(ti."invited_email") = lower(u."email")
  AND ti."status" = 'pending'
  AND ti."expires_at" > now();