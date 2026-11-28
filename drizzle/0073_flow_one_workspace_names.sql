-- Gives each personal institution that stores no name the neutral name Ruang kerja pribadi, once.
-- The owner's username is not used, because the institution is listed for search engines.
UPDATE "institutions"
SET "display_name" = 'Ruang kerja pribadi'
WHERE "institution_type" = 'personal'
  AND "display_name" IS NULL;
