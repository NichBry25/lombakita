CREATE TABLE "platform_ops_audit_logs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"actor_user_id" text NOT NULL,
	"target_user_id" text,
	"target_institution_id" text,
	"event_type" text NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_ops_audit_logs_target_present_chk" CHECK ("platform_ops_audit_logs"."target_user_id" IS NOT NULL OR "platform_ops_audit_logs"."target_institution_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "platform_ops_notes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"target_user_id" text,
	"target_institution_id" text,
	"note" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_ops_notes_single_target_chk" CHECK (("platform_ops_notes"."target_user_id" IS NOT NULL AND "platform_ops_notes"."target_institution_id" IS NULL) OR ("platform_ops_notes"."target_user_id" IS NULL AND "platform_ops_notes"."target_institution_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "platform_ops_audit_logs" ADD CONSTRAINT "platform_ops_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_ops_audit_logs" ADD CONSTRAINT "platform_ops_audit_logs_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_ops_audit_logs" ADD CONSTRAINT "platform_ops_audit_logs_target_institution_id_institutions_id_fk" FOREIGN KEY ("target_institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_ops_notes" ADD CONSTRAINT "platform_ops_notes_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_ops_notes" ADD CONSTRAINT "platform_ops_notes_target_institution_id_institutions_id_fk" FOREIGN KEY ("target_institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_ops_notes" ADD CONSTRAINT "platform_ops_notes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_ops_audit_logs_target_user_id_idx" ON "platform_ops_audit_logs" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "platform_ops_audit_logs_target_institution_id_idx" ON "platform_ops_audit_logs" USING btree ("target_institution_id");--> statement-breakpoint
CREATE INDEX "platform_ops_notes_target_user_id_idx" ON "platform_ops_notes" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "platform_ops_notes_target_institution_id_idx" ON "platform_ops_notes" USING btree ("target_institution_id");