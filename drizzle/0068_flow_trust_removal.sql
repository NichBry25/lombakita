-- A trusted host can lose trust, and only on purpose.
--
-- Migration 0061 refuses every backwards move of recruiter_verification_tier. Staff now remove a
-- host's trust by moving the tier from elevated to minimal. This function allows exactly that
-- move, and only inside a transaction that ran SET LOCAL lombakita.trust_removal = 'on'. Every
-- other backwards move, and this move without the setting, is refused exactly as before. The
-- trigger from 0061 is unchanged.
CREATE OR REPLACE FUNCTION "users_recruiter_tier_no_downgrade"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."recruiter_verification_tier" = 'elevated'
     AND NEW."recruiter_verification_tier" = 'minimal'
     AND current_setting('lombakita.trust_removal', true) = 'on' THEN
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
