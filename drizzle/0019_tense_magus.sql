-- Step 4.0c (Sch4.0c-M2) — Recruiter tier consistency CHECK.
-- Enforces the invariant: any row with recruiter_verified_at IS NOT NULL must hold a tier
-- above 'unverified'. Makes 4.0c-M1 (markRoleAsVerifiedStub-style write paths that flip
-- recruiter_verified_at without setting the tier) impossible at the DB layer.
--
-- Step A — Backfill any row already violating the new invariant. Migration 0018 set every
-- existing row to tier='unverified' via the column default; any row that already held
-- recruiter_verified_at IS NOT NULL (from rollback Step 1.3 or earlier signup paths) must be
-- lifted to 'minimal' before the CHECK lands, otherwise the ALTER fails with 23514. This
-- backfill is the corrective counterpart to migration 0018's blanket-default choice: rows that
-- "should have been" minimal at 0018 time get there now.
UPDATE "users"
SET "recruiter_verification_tier" = 'minimal'
WHERE "recruiter_verified_at" IS NOT NULL
  AND "recruiter_verification_tier" = 'unverified';
--> statement-breakpoint

-- Step B — Add the CHECK constraint. From this point forward, the application 4.0c-M1 fix
-- (markRoleAsVerifiedStub writes tier='minimal' in the same UPDATE as recruiter_verified_at)
-- is enforced by the DB. Any write path that forgets to set the tier is rejected at INSERT/
-- UPDATE time rather than silently producing an inconsistent row.
ALTER TABLE "users" ADD CONSTRAINT "users_recruiter_tier_consistency_chk" CHECK ("users"."recruiter_verified_at" IS NULL OR "users"."recruiter_verification_tier" <> 'unverified');