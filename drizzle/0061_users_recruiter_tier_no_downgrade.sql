-- The tier column cannot run backwards.
--
-- `recruiter_verification_tier` is a Postgres enum, so the database knows the ORDER of its labels
-- (`pg_enum.enumsortorder`, which is declaration order) and nothing at all about which DIRECTIONS
-- are legal. Every other ordering guarantee on `users` is a CHECK; this one had none, so
-- `elevated` -> `minimal` was a legal UPDATE for any role that can write the table, and the only
-- thing preventing it was the absence of a service that issues one. LAUNCH-D73.
--
-- THE ORDER IS NOT DECLARED HERE and must not be. It is declared once, by the enum in
-- `src/server/db/schema.ts`, and this trigger reads that declaration through the enum's own
-- comparison operator rather than restating a rank. A rank written into the trigger would be a
-- second copy, and the second copy is the one that drifts.
--
-- `BEFORE UPDATE OF "recruiter_verification_tier"` fires only when the statement's SET list names
-- the column. An UPDATE that does not touch the tier pays nothing for this, and an UPDATE that
-- sets it to its current value is not a downgrade (`NEW < OLD` is false), so idempotent writes
-- stay idempotent.
--
-- WHAT `BEFORE UPDATE OF` COSTS LATER, so the next person does not discover it from a failed
-- migration. Naming the column puts it into the trigger definition, and Postgres then refuses
-- `ALTER TABLE "users" ALTER COLUMN "recruiter_verification_tier" TYPE ...` with SQLSTATE 0A000,
-- "cannot alter type of a column used in a trigger definition". That statement is this
-- repository's established recipe for reshaping an enum column — 0015_two_role_identity_rebuild
-- and 0016_institution_membership_role_rebuild both use it, on `users.role`. Any migration that
-- reorders these labels, removes one, or swaps the type must first run
-- `DROP TRIGGER "users_recruiter_tier_no_downgrade" ON "users"` and re-create it afterwards.
--
-- OR REPLACE ON BOTH, so replaying this file over an object that already exists is a no-op rather
-- than SQLSTATE 42723. PG 14+ for the trigger form; this repo runs 16 and 17.
--
-- THE BODY OF THIS FILE WAS EDITED AFTER IT HAD BEEN APPLIED LOCALLY, and `OR REPLACE` is what
-- lets a fresh application pick the edited body up instead of failing on 42723. THAT IS SAFE ONLY
-- WHILE NO DEPLOYED ENVIRONMENT HAS APPLIED 0061. A local reset rebuilds from zero, so an edited
-- body there is just the body. A migrated environment is different, and NOT silently so:
-- drizzle-kit skips a file it has already applied, so the edit never reaches that database, but
-- this repository's ledger verifier (src/server/db/schema-drift.ts:151, the per-row compare inside
-- `compareAppliedToJournal`, called from scripts/reset/reset-local.ts:315 — whose success line is
-- the `matching row for row by hash` printed at :352 — and from
-- src/server/scripts/verify-schema-drift.ts:154, the blocking gate deploy.yml runs at :103 and
-- :231; a fourth compare is inline rather than shared, scripts/reset/reset-local.ts:338, pinning
-- LAUNCH-D29's two indices) compares each applied row's hash against the file and will report the
-- edit as a divergence. That is LAUNCH-D29's mechanism exactly: 0032 and 0047 were edited in
-- 8206ec4 after application and now carry two accepted hashes per index.
-- Evidence that no deployed environment has 0061: it was created on this branch and is absent
-- from main, and migrations reach deployed databases only through a manual operator step
-- (deploy.yml:162 — that job deploys code only, and refuses a database whose history differs).
-- Once 0061 is applied anywhere that is not rebuilt from zero, this body is frozen and any
-- further change needs its own migration.
CREATE OR REPLACE FUNCTION "users_recruiter_tier_no_downgrade"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."recruiter_verification_tier" < OLD."recruiter_verification_tier" THEN
    RAISE EXCEPTION
      'recruiter_verification_tier cannot move backwards: % -> %',
      OLD."recruiter_verification_tier", NEW."recruiter_verification_tier"
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'users_recruiter_tier_no_downgrade';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "users_recruiter_tier_no_downgrade"
  BEFORE UPDATE OF "recruiter_verification_tier" ON "users"
  FOR EACH ROW
  EXECUTE FUNCTION "users_recruiter_tier_no_downgrade"();
