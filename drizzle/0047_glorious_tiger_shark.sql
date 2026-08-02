-- IF NOT EXISTS because 0032 now declares 'draft' up front. On a database that predates this fix
-- the value is genuinely missing and this statement adds it; on one built from zero it is already
-- present and this is a no-op. Both paths converge on the same four values in the same order.
ALTER TYPE "public"."verification_submission_status" ADD VALUE IF NOT EXISTS 'draft' BEFORE 'pending_review';