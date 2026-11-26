-- The trust removal opt-in counts only for the transaction that set it.
--
-- Migration 0068 accepted any visible value 'on' of lombakita.trust_removal, so a session-level
-- SET or an ALTER ROLE SET would have opened the move for every later transaction. The opt-in
-- is now the current transaction id, set with
-- set_config('lombakita.trust_removal', txid_current()::text, true): a value left from another
-- transaction never matches. The allowed move (elevated to minimal), every refusal, its error
-- text, error code and constraint name, and the trigger from 0061 are unchanged.
CREATE OR REPLACE FUNCTION "users_recruiter_tier_no_downgrade"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."recruiter_verification_tier" = 'elevated'
     AND NEW."recruiter_verification_tier" = 'minimal'
     AND current_setting('lombakita.trust_removal', true) = txid_current()::text THEN
    RETURN NEW;
  END IF;
  IF NEW."recruiter_verification_tier" < OLD."recruiter_verification_tier" THEN
    RAISE EXCEPTION
      'recruiter_verification_tier cannot move backwards: % -> %',
      OLD."recruiter_verification_tier", NEW."recruiter_verification_tier"
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'users_recruiter_tier_no_downgrade';
  END IF;
  RETURN NEW;
END;
$$;
