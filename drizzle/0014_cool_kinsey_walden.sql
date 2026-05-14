CREATE TYPE "public"."competition_registration_status" AS ENUM('confirmed', 'cancelled', 'pending_payment');--> statement-breakpoint
CREATE TYPE "public"."competition_registration_type" AS ENUM('individual', 'team');--> statement-breakpoint
CREATE TABLE "competition_registrations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"competition_id" text NOT NULL,
	"student_id" text NOT NULL,
	"registration_type" "competition_registration_type" DEFAULT 'individual' NOT NULL,
	"status" "competition_registration_status" DEFAULT 'confirmed' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competition_registrations" ADD CONSTRAINT "competition_registrations_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_registrations" ADD CONSTRAINT "competition_registrations_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_registrations_competition_id_idx" ON "competition_registrations" USING btree ("competition_id");--> statement-breakpoint
CREATE INDEX "competition_registrations_student_id_idx" ON "competition_registrations" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competition_registrations_student_competition_active_unique_idx" ON "competition_registrations" USING btree ("student_id","competition_id") WHERE "competition_registrations"."status" <> 'cancelled';