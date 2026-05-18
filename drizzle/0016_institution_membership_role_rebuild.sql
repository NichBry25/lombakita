-- Step 1.4 — Institution Membership Role Rebuild (CCR-06 / DEC-0040, CCR-08 / DEC-0042, CCR-09 / DEC-0043)
-- Renames the `institution_admin` membership role to `institution_owner`, removes the
-- unused `reviewer_or_judge` value from the membership enum, and adds `institution_member`
-- as a new cosmetic-at-launch role.
--
-- Tables referencing institution_membership_role enum:
--   1. institution_memberships.membership_role
--   2. institution_invitations.invited_role
--
-- Migration sequence:
--   Step A — RENAME VALUE: renames institution_admin → institution_owner in the enum type
--            AND all existing rows atomically. PostgreSQL handles the row rewrite internally.
--   Step B — Data migration: rewrite any reviewer_or_judge rows to institution_staff while
--            that value is still valid (before the enum recreation removes it).
--   Step C — Enum recreation: cast both columns to text, drop the old type, create the new
--            type with the three target values, cast both columns back.

-- Step A — Rename institution_admin to institution_owner ----------------------------------------
ALTER TYPE "public"."institution_membership_role" RENAME VALUE 'institution_admin' TO 'institution_owner';
--> statement-breakpoint

-- Step B — Data migration: rewrite reviewer_or_judge rows (safety net; never written via API) ----
UPDATE "institution_memberships"
SET "membership_role" = 'institution_staff'
WHERE "membership_role" = 'reviewer_or_judge';
--> statement-breakpoint
UPDATE "institution_invitations"
SET "invited_role" = 'institution_staff'
WHERE "invited_role" = 'reviewer_or_judge';
--> statement-breakpoint

-- Step C — Enum recreation: remove reviewer_or_judge, add institution_member -------------------
ALTER TABLE "institution_memberships" ALTER COLUMN "membership_role" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "institution_invitations" ALTER COLUMN "invited_role" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."institution_membership_role";
--> statement-breakpoint
CREATE TYPE "public"."institution_membership_role" AS ENUM(
  'institution_owner',
  'institution_staff',
  'institution_member'
);
--> statement-breakpoint
ALTER TABLE "institution_memberships"
  ALTER COLUMN "membership_role" SET DATA TYPE "public"."institution_membership_role"
  USING "membership_role"::"public"."institution_membership_role";
--> statement-breakpoint
ALTER TABLE "institution_invitations"
  ALTER COLUMN "invited_role" SET DATA TYPE "public"."institution_membership_role"
  USING "invited_role"::"public"."institution_membership_role";
