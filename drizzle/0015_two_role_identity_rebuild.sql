-- Rollback Step 1.3 — Identity Core rebuild (CCR-01 / DEC-0035, CCR-02 / DEC-0036, CCR-15 / DEC-0049).
-- Swaps the user-level role enum to the two-role identity model (candidate + recruiter),
-- removes institution_admin and institution_staff from user-level scope (membership-layer enum
-- `institution_membership_role` is untouched — that is Step 1.4 territory), and adds the
-- per-role verification timestamp columns plus the "every account holds one verified role"
-- invariant (CHECK constraint).
--
-- Migration sequence (idempotent within a single guarded run; data-safe across dev/staging/prod):
--   Step B — app_role enum swap (the USING CASE remaps all three legacy values atomically):
--     B1. Drop the column default, cast the column to text (this releases the column from
--         the old enum type so the type can be dropped), drop the old enum, recreate it with
--         the new value set, cast the column back through a CASE that maps legacy values:
--           'student'           → 'candidate'
--           'institution_admin' → 'recruiter'   (CCR-05 / CCR-07: only recruiter-verified
--           'institution_staff' → 'recruiter'    can hold institution owner/staff capability)
--           ELSE                → identity (preserves reviewer_or_judge / platform_ops /
--                                 finance_ops). The user's institution_memberships row is
--                                 preserved and continues to authoritatively express
--                                 tenant-membership role.
--         Re-establish the default ('candidate'). NB: a pre-rename UPDATE-then-swap dance is
--         NOT viable because we cannot cast text 'recruiter' to the old enum (which lacks
--         that value) and cannot reference the new enum before it is created. The single
--         column-text-cast + USING CASE flow is the correct sequence for this kind of
--         remove-and-add enum rebuild.
--   Step C — platform_user_role enum swap (parallel to app_role):
--     C1. The auxiliary user-platform-roles enum currently contains 'student'. The same swap
--         dance is applied: drop default if any → cast to text → drop type → recreate →
--         cast back via CASE that maps 'student' → 'candidate'.
--   Step D — per-role verification columns + CHECK invariant:
--     D1. Add candidate_verified_at and recruiter_verified_at timestamptz columns (nullable).
--     D2. Backfill: rows whose post-rename role is 'candidate' receive candidate_verified_at;
--         rows whose post-rename role is 'recruiter' receive recruiter_verified_at; any other
--         account (platform_ops, finance_ops, reviewer_or_judge) is tagged with
--         candidate_verified_at as the safe baseline so the CHECK is satisfied (these accounts
--         do not gain any product-side privilege from the timestamp — they are platform-side
--         actors and the candidate flag is a no-op for their access surfaces).
--     D3. Attach the at-least-one-verified-role CHECK constraint. Runs AFTER backfill so
--         existing rows pass the invariant on the very first transaction.

-- Step B1 — app_role enum swap ---------------------------------------------------------------
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."app_role";
--> statement-breakpoint
CREATE TYPE "public"."app_role" AS ENUM('candidate', 'recruiter', 'reviewer_or_judge', 'platform_ops', 'finance_ops');
--> statement-breakpoint
ALTER TABLE "users"
  ALTER COLUMN "role" SET DATA TYPE "public"."app_role"
  USING (
    CASE "role"
      WHEN 'student' THEN 'candidate'
      WHEN 'institution_admin' THEN 'recruiter'
      WHEN 'institution_staff' THEN 'recruiter'
      ELSE "role"
    END
  )::"public"."app_role";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'candidate'::"public"."app_role";
--> statement-breakpoint

-- Step C1 — platform_user_role enum swap -----------------------------------------------------
ALTER TABLE "user_platform_roles" ALTER COLUMN "role" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."platform_user_role";
--> statement-breakpoint
CREATE TYPE "public"."platform_user_role" AS ENUM('candidate', 'platform_ops', 'finance_ops');
--> statement-breakpoint
ALTER TABLE "user_platform_roles"
  ALTER COLUMN "role" SET DATA TYPE "public"."platform_user_role"
  USING (
    CASE "role"
      WHEN 'student' THEN 'candidate'
      ELSE "role"
    END
  )::"public"."platform_user_role";
--> statement-breakpoint

-- Step D1 — per-role verification columns ----------------------------------------------------
ALTER TABLE "users" ADD COLUMN "candidate_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recruiter_verified_at" timestamp with time zone;
--> statement-breakpoint

-- Step D2 — backfill -------------------------------------------------------------------------
UPDATE "users" SET "candidate_verified_at" = now() WHERE "role" = 'candidate';
--> statement-breakpoint
UPDATE "users" SET "recruiter_verified_at" = now() WHERE "role" = 'recruiter';
--> statement-breakpoint
UPDATE "users" SET "candidate_verified_at" = now()
WHERE "candidate_verified_at" IS NULL AND "recruiter_verified_at" IS NULL;
--> statement-breakpoint

-- Step D3 — CHECK constraint -----------------------------------------------------------------
ALTER TABLE "users" ADD CONSTRAINT "users_one_verified_role_chk"
  CHECK ("users"."candidate_verified_at" IS NOT NULL OR "users"."recruiter_verified_at" IS NOT NULL);
