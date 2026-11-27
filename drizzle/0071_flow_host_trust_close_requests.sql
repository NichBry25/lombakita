-- Closes every host request of the old flow that is still open. The old flow never wrote
-- competition_id, so a null competition_id marks its rows; a host check of the new flow always
-- carries one. Nothing is deleted: the rows stay as history and for DEC-0274.
UPDATE "recruiter_verification_submissions"
SET "status" = 'rejected',
    "rejection_reason" = 'Ditutup karena alur penyelenggara berubah.',
    "resubmission_allowed" = false,
    "reviewed_at" = now()
WHERE "status" IN ('draft', 'pending_review')
  AND "competition_id" IS NULL;
