CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
