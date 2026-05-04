CREATE TABLE "institution_audit_logs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"institution_id" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_membership_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institution_audit_logs" ADD CONSTRAINT "institution_audit_logs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_audit_logs" ADD CONSTRAINT "institution_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_audit_logs" ADD CONSTRAINT "institution_audit_logs_target_membership_id_institution_memberships_id_fk" FOREIGN KEY ("target_membership_id") REFERENCES "public"."institution_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "institution_audit_logs_institution_id_idx" ON "institution_audit_logs" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "institution_audit_logs_action_idx" ON "institution_audit_logs" USING btree ("action");