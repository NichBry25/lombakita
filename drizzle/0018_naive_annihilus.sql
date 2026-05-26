-- Step 4.0c (CCR-19 / DEC-0053) — Recruiter Tier State.
-- Introduces the recruiter_verification_tier enum and adds the tier column on users.
-- Backfill rule: existing rows (including recruiter-verified accounts) land on 'unverified'
-- via the column default. No application-layer fix-up is needed because no production users
-- exist at this point in the roadmap; the migration is correct regardless of seed data.
-- New recruiter signups land on 'minimal' atomically via registerUserWithCredentials.
CREATE TYPE "public"."recruiter_verification_tier" AS ENUM('unverified', 'minimal', 'elevated');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recruiter_verification_tier" "recruiter_verification_tier" DEFAULT 'unverified' NOT NULL;