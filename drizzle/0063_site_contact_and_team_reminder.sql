CREATE TYPE "public"."organizer_contact_kind" AS ENUM('whatsapp', 'phone', 'email');--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "organizer_contact_kind" "organizer_contact_kind";--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "organizer_contact_value" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "join_reminder_close_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_organizer_contact_pair_chk" CHECK (("competitions"."organizer_contact_kind" IS NULL) = ("competitions"."organizer_contact_value" IS NULL));