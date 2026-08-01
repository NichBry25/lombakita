-- Retire the competition archive state and record when results are promised.
--
-- A finished competition now stays published so its rules, prize terms, organizer contact
-- details, and results remain publicly reachable after the event. How far along a competition is
-- derives from its dates and its results, so no status flip is needed to express "finished".
--
-- Existing archived rows return to draft: draft is the non-public, fully reversible state, and
-- re-publishing runs the full publish checklist rather than restoring a row straight to public
-- view. The competition_status enum keeps its 'archived' value because Postgres cannot drop an
-- enum value; no application path can produce it.
UPDATE "competitions" SET "status" = 'draft', "updated_at" = now() WHERE "status" = 'archived';--> statement-breakpoint
ALTER TABLE "competitions" DROP COLUMN "archived_at";--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "result_announcement_at" timestamp with time zone;
