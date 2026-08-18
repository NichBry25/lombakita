CREATE TYPE "public"."finance_fee_accrual_entry" AS ENUM('accrued', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."finance_manual_proof_status" AS ENUM('pending_review', 'verified', 'rejected', 'voided');--> statement-breakpoint
CREATE TYPE "public"."finance_payment_origin" AS ENUM('manual_transfer', 'gateway');--> statement-breakpoint
CREATE TABLE "finance_fee_accruals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"payment_id" text NOT NULL,
	"owing_institution_id" text NOT NULL,
	"entry_type" "finance_fee_accrual_entry" NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"fee_rule_id" text NOT NULL,
	"fee_basis_points" integer NOT NULL,
	"fee_flat_amount" bigint NOT NULL,
	"gross_amount" bigint NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_fee_accruals_currency_chk" CHECK ("finance_fee_accruals"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_fee_accruals_amount_sign_chk" CHECK (("finance_fee_accruals"."entry_type" = 'accrued' AND "finance_fee_accruals"."amount" >= 0) OR ("finance_fee_accruals"."entry_type" = 'reversed' AND "finance_fee_accruals"."amount" <= 0)),
	CONSTRAINT "finance_fee_accruals_reason_required_chk" CHECK ("finance_fee_accruals"."entry_type" <> 'reversed' OR ("finance_fee_accruals"."reason" IS NOT NULL AND btrim("finance_fee_accruals"."reason") <> '')),
	CONSTRAINT "finance_fee_accruals_fee_snapshot_chk" CHECK ("finance_fee_accruals"."fee_basis_points" >= 0 AND "finance_fee_accruals"."fee_basis_points" <= 10000 AND "finance_fee_accruals"."fee_flat_amount" >= 0 AND "finance_fee_accruals"."gross_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "finance_manual_payment_proofs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"payment_id" text NOT NULL,
	"competition_id" text NOT NULL,
	"submitted_by_user_id" text NOT NULL,
	"status" "finance_manual_proof_status" DEFAULT 'pending_review' NOT NULL,
	"r2_key" text NOT NULL,
	"original_file_name" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"reviewer_user_id" text,
	"rejection_reason" text,
	"resubmission_allowed" boolean DEFAULT true NOT NULL,
	"resubmission_count" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_manual_payment_proofs_rejection_reason_chk" CHECK ("finance_manual_payment_proofs"."status" <> 'rejected' OR ("finance_manual_payment_proofs"."rejection_reason" IS NOT NULL AND btrim("finance_manual_payment_proofs"."rejection_reason") <> '')),
	CONSTRAINT "finance_manual_payment_proofs_reviewed_chk" CHECK ("finance_manual_payment_proofs"."status" IN ('pending_review') OR "finance_manual_payment_proofs"."reviewed_at" IS NOT NULL),
	CONSTRAINT "finance_manual_payment_proofs_file_size_chk" CHECK ("finance_manual_payment_proofs"."file_size_bytes" > 0),
	CONSTRAINT "finance_manual_payment_proofs_resubmission_count_chk" CHECK ("finance_manual_payment_proofs"."resubmission_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "institution_payment_instructions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"institution_id" text NOT NULL,
	"bank_name" text,
	"account_number" text,
	"account_holder_name" text,
	"qris_r2_key" text,
	"instructions_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institution_payment_instructions_payable_chk" CHECK ("institution_payment_instructions"."qris_r2_key" IS NOT NULL OR ("institution_payment_instructions"."bank_name" IS NOT NULL AND "institution_payment_instructions"."account_number" IS NOT NULL AND "institution_payment_instructions"."account_holder_name" IS NOT NULL))
);
--> statement-breakpoint
DO $$
DECLARE
  fractional_count bigint;
  uncurrencied_count bigint;
  existing_payment_count bigint;
  unverified_paid_count bigint;
BEGIN
  -- PRE-FLIGHT REFUSAL 1 — a fee with a fractional part cannot survive the cast.
  -- fee_amount was numeric(12,2); it becomes an integer count of the currency's smallest unit,
  -- and IDR has exponent 0, so the rupiah IS the smallest unit. A stored 50000.50 has no integer
  -- representation, and Postgres's assignment cast would ROUND it rather than fail — silently
  -- changing a price. Refusing here is what makes the USING clause below exact rather than lossy.
  SELECT count(*) INTO fractional_count
    FROM competitions
   WHERE fee_amount IS NOT NULL AND fee_amount <> trunc(fee_amount);

  IF fractional_count > 0 THEN
    RAISE EXCEPTION
      'Refusing fee_amount migration: % competition row(s) carry a fractional fee, which cannot be represented in IDR smallest units. Resolve each row before migrating.',
      fractional_count;
  END IF;

  -- PRE-FLIGHT REFUSAL 2 — a price with no currency, or one this system cannot interpret.
  -- An integer amount is meaningless without the currency that says what it counts. A row priced
  -- in anything but IDR would be read under IDR's exponent 0 by every consumer downstream.
  SELECT count(*) INTO uncurrencied_count
    FROM competitions
   WHERE fee_amount IS NOT NULL
     AND fee_amount <> 0
     AND (fee_currency IS NULL OR fee_currency <> 'IDR');

  IF uncurrencied_count > 0 THEN
    RAISE EXCEPTION
      'Refusing fee_amount migration: % priced competition row(s) carry a null or non-IDR fee_currency. Set fee_currency before migrating.',
      uncurrencied_count;
  END IF;

  -- PRE-FLIGHT REFUSAL 3 — finance_payments.origin is added NOT NULL with NO DEFAULT, on purpose.
  -- Origin records which lane a payment was actually taken through, and for a row that predates the
  -- column there is no true answer: 'manual_transfer' and 'gateway' would both be a guess written
  -- into the ledger as fact, and every fee accrual, split assertion and reconciliation downstream
  -- reads it as though somebody knew. A backfill is therefore FORBIDDEN, not merely undesirable.
  --
  -- The bare ADD COLUMN below would fail on its own, but with a SQLSTATE 23502 that reads as an
  -- oversight and invites exactly the DEFAULT someone would add to make it pass. This refusal says
  -- what the right response is instead: stop, and escalate.
  SELECT count(*) INTO existing_payment_count FROM finance_payments;

  IF existing_payment_count > 0 THEN
    RAISE EXCEPTION
      'Refusing origin migration: finance_payments holds % row(s) predating the origin column. Do NOT add a DEFAULT and do NOT backfill — every available value would be a fabricated claim about which lane real money moved through. Escalate before proceeding.',
      existing_payment_count;
  END IF;

  -- NOT a refusal (DEC-0158). A paid competition owned by an institution that is not verified is a
  -- DEFINED RUNTIME STATE, not a data defect: verification gates the right to CHARGE, never the
  -- right to PUBLISH, and revocation is a credibility change rather than a takedown (DEC-0118).
  -- Payment and registration on such a competition are refused at the runtime charging gate.
  -- Nothing is mutated here; the count is surfaced so the state is visible rather than discovered.
  SELECT count(*) INTO unverified_paid_count
    FROM competitions c
    JOIN institutions i ON i.id = c.institution_id
   WHERE c.fee_amount IS NOT NULL
     AND c.fee_amount <> 0
     AND i.verification_status <> 'verified';

  IF unverified_paid_count > 0 THEN
    RAISE NOTICE
      'DEC-0158: % paid competition(s) belong to an institution that is not verified. This is a defined state; charging is refused at runtime and no row is modified here.',
      unverified_paid_count;
  END IF;
END $$;--> statement-breakpoint
-- Exact because the pre-flight above refused every row that could not survive it. trunc() is
-- explicit rather than relying on the assignment cast's rounding, so the intent is readable at the
-- statement rather than inferred from the guard fifty lines up.
ALTER TABLE "competitions" ALTER COLUMN "fee_amount" SET DATA TYPE bigint USING trunc("fee_amount")::bigint;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "payment_window_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD COLUMN "origin" "finance_payment_origin" NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finance_fee_accruals" ADD CONSTRAINT "finance_fee_accruals_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."finance_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fee_accruals" ADD CONSTRAINT "finance_fee_accruals_owing_institution_id_fk" FOREIGN KEY ("owing_institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fee_accruals" ADD CONSTRAINT "finance_fee_accruals_fee_rule_id_fk" FOREIGN KEY ("fee_rule_id") REFERENCES "public"."finance_fee_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_manual_payment_proofs" ADD CONSTRAINT "finance_manual_payment_proofs_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."finance_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_manual_payment_proofs" ADD CONSTRAINT "finance_manual_payment_proofs_competition_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_manual_payment_proofs" ADD CONSTRAINT "finance_manual_payment_proofs_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_manual_payment_proofs" ADD CONSTRAINT "finance_manual_payment_proofs_reviewer_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_payment_instructions" ADD CONSTRAINT "institution_payment_instructions_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_fee_accruals_payment_accrued_unique_idx" ON "finance_fee_accruals" USING btree ("payment_id") WHERE "finance_fee_accruals"."entry_type" = 'accrued';--> statement-breakpoint
CREATE UNIQUE INDEX "finance_fee_accruals_payment_reversed_unique_idx" ON "finance_fee_accruals" USING btree ("payment_id") WHERE "finance_fee_accruals"."entry_type" = 'reversed';--> statement-breakpoint
CREATE INDEX "finance_fee_accruals_owing_institution_id_idx" ON "finance_fee_accruals" USING btree ("owing_institution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_manual_payment_proofs_payment_unique_idx" ON "finance_manual_payment_proofs" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "finance_manual_payment_proofs_competition_status_idx" ON "finance_manual_payment_proofs" USING btree ("competition_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_payment_instructions_institution_unique_idx" ON "institution_payment_instructions" USING btree ("institution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_competition_id_id_unique_idx" ON "teams" USING btree ("competition_id","id");--> statement-breakpoint
ALTER TABLE "competition_registrations" ADD CONSTRAINT "competition_registrations_competition_team_fk" FOREIGN KEY ("competition_id","team_id") REFERENCES "public"."teams"("competition_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_fee_currency_required_chk" CHECK ("competitions"."fee_amount" IS NULL OR "competitions"."fee_amount" = 0 OR "competitions"."fee_currency" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_fee_currency_shape_chk" CHECK ("competitions"."fee_currency" IS NULL OR "competitions"."fee_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_payment_window_days_chk" CHECK ("competitions"."payment_window_days" >= 1 AND "competitions"."payment_window_days" <= 30);--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_manual_lane_no_split_chk" CHECK ("finance_payments"."origin" <> 'manual_transfer' OR ("finance_payments"."platform_fee_amount" = 0 AND "finance_payments"."institution_net_amount" = "finance_payments"."gross_amount"));--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_manual_due_at_chk" CHECK ("finance_payments"."origin" <> 'manual_transfer' OR "finance_payments"."due_at" IS NOT NULL);