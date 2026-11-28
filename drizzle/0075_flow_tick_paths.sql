-- Records how each institution verified before the tick existed got its tick (ruling 12:
-- verified institutions get the tick). A verified institution with an approved document
-- request won it by documents; every other verified institution was verified by staff directly.
UPDATE "institutions" AS i
SET "tick_path" = 'documents'
WHERE i."verification_status" = 'verified'
  AND i."tick_path" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "institution_verification_submissions" AS s
    WHERE s."institution_id" = i."id"
      AND s."status" = 'approved'
  );
--> statement-breakpoint
UPDATE "institutions"
SET "tick_path" = 'staff'
WHERE "verification_status" = 'verified'
  AND "tick_path" IS NULL;
