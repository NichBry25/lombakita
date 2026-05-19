-- Step 2.1 (re-execution) — User Profile Shell Rebuild
-- Adds username to users table and extends user_profiles with scoped profile fields.
--
-- Migration sequence:
--   Step A — Add new columns to user_profiles (all nullable, no data migration needed).
--   Step B — Add username to users as nullable, backfill from email prefix, then enforce NOT NULL.
--            Backfill format: <email_prefix_slugified>_<first_8_chars_of_id_hash>
--            The email prefix is lowercased, non-alphanumeric chars replaced with '_',
--            consecutive underscores collapsed, leading/trailing underscores stripped, and
--            truncated to 20 chars. The id hash suffix guarantees uniqueness even when multiple
--            accounts share the same email prefix pattern.
--   Step C — Add unique index on username.

-- Step A: New user_profiles columns --------------------------------------------------------
ALTER TABLE "user_profiles" ADD COLUMN "location" text;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "university" text;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "major" text;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "graduation_year" integer;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "role_title" text;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "organization_name" text;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "website_url" text;
--> statement-breakpoint

-- Step B: username — add nullable, backfill, set NOT NULL ------------------------------------
ALTER TABLE "users" ADD COLUMN "username" text;
--> statement-breakpoint

UPDATE "users"
SET "username" = (
  -- Slugify email prefix (up to 20 chars) + 8-char id-hash suffix for uniqueness.
  substring(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(split_part("email", '@', 1)), '[^a-z0-9]', '_', 'g'),
        '_+', '_', 'g'
      ),
      '^_+|_+$', '', 'g'
    )
    from 1 for 20
  ) || '_' || left(md5("id"), 8)
);
--> statement-breakpoint

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
--> statement-breakpoint

-- Step C: Unique index on username ----------------------------------------------------------
CREATE UNIQUE INDEX "users_username_unique_idx" ON "users" USING btree ("username");
