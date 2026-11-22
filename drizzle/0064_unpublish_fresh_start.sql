ALTER TABLE "competition_registrations" ADD COLUMN "publication_closed_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "teams_competition_id_name_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "teams_competition_id_name_unique_idx" ON "teams" USING btree ("competition_id","name") WHERE "teams"."status" <> 'cancelled';