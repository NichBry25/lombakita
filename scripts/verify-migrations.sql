-- Verifies the outstanding migrations 0050-0054 by introspecting the live schema.
-- The __drizzle_migrations ledger is NOT readable by the app role, so this checks what the
-- migrations actually DID rather than what a journal claims.
-- Every row must read PASS.

SELECT '0050 institutions.banner_r2_key' AS check_name,
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — column missing' END AS result
FROM information_schema.columns
WHERE table_name = 'institutions' AND column_name = 'banner_r2_key'

UNION ALL SELECT '0050 user_profiles.banner_r2_key',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — column missing' END
FROM information_schema.columns
WHERE table_name = 'user_profiles' AND column_name = 'banner_r2_key'

UNION ALL SELECT '0051/0052 institution pending unique index',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — index missing or wrong name' END
FROM pg_indexes
WHERE indexname = 'institution_verification_submissions_pending_unique_idx'

UNION ALL SELECT '0053 competition_document_requests table',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — table missing' END
FROM information_schema.tables
WHERE table_name = 'competition_document_requests'

UNION ALL SELECT '0053 competition_document_request_files table',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — table missing' END
FROM information_schema.tables
WHERE table_name = 'competition_document_request_files'

UNION ALL SELECT '0053 registration_document_request_status enum (5 values)',
       CASE WHEN count(*) = 5 THEN 'PASS' ELSE 'FAIL — got ' || count(*) || ' values' END
FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'registration_document_request_status'

-- Pinned by exact name AND by its partial predicate: a name silently truncated past Postgres's
-- 63-char limit (the DEC-0120 defect) would fail this check rather than pass unnoticed.
UNION ALL SELECT '0053 open-request partial unique index',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — index missing or wrong name' END
FROM pg_indexes
WHERE indexname = 'competition_document_requests_open_unique_idx'
  AND indexdef LIKE '%UNIQUE%'
  AND indexdef LIKE '%WHERE%'

-- 0054 is the only outstanding migration that is NOT purely additive: it DROPS a column and
-- REWRITES rows, so all three of these must hold.
UNION ALL SELECT '0054 competitions.archived_at DROPPED',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL — column still present' END
FROM information_schema.columns
WHERE table_name = 'competitions' AND column_name = 'archived_at'

UNION ALL SELECT '0054 competitions.result_announcement_at ADDED',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — column missing' END
FROM information_schema.columns
WHERE table_name = 'competitions'
  AND column_name = 'result_announcement_at'
  AND data_type = 'timestamp with time zone'
  AND is_nullable = 'YES'

UNION ALL SELECT '0054 no competition left in archived status',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL — ' || count(*) || ' archived row(s)' END
FROM competitions
WHERE status = 'archived';
