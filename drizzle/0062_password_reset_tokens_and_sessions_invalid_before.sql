CREATE TABLE "user_password_reset_tokens" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sessions_invalid_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_password_reset_tokens" ADD CONSTRAINT "user_password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_password_reset_tokens_token_hash_unique_idx" ON "user_password_reset_tokens" USING btree ("token_hash");