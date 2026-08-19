CREATE TABLE "finance_fee_disclosure_acknowledgements" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"competition_id" text NOT NULL,
	"institution_id" text NOT NULL,
	"acknowledged_by_user_id" text NOT NULL,
	"fee_rule_id" text NOT NULL,
	"fee_basis_points" integer NOT NULL,
	"fee_flat_amount" bigint NOT NULL,
	"fee_amount" bigint NOT NULL,
	"fee_currency" text NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_fee_disclosure_acknowledgements_fee_amount_chk" CHECK ("finance_fee_disclosure_acknowledgements"."fee_amount" > 0),
	CONSTRAINT "finance_fee_disclosure_acknowledgements_fee_terms_chk" CHECK ("finance_fee_disclosure_acknowledgements"."fee_basis_points" >= 0 AND "finance_fee_disclosure_acknowledgements"."fee_flat_amount" >= 0),
	CONSTRAINT "finance_fee_disclosure_acknowledgements_currency_shape_chk" CHECK ("finance_fee_disclosure_acknowledgements"."fee_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "finance_manual_payment_proof_attempts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"proof_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"competition_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"submitted_by_user_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"original_file_name" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"verdict" "finance_manual_proof_status" NOT NULL,
	"verdict_reason" text,
	"reviewer_user_id" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_manual_payment_proof_attempts_verdict_chk" CHECK ("finance_manual_payment_proof_attempts"."verdict" IN ('verified', 'rejected', 'voided')),
	CONSTRAINT "finance_manual_payment_proof_attempts_attempt_number_chk" CHECK ("finance_manual_payment_proof_attempts"."attempt_number" >= 0),
	CONSTRAINT "finance_manual_payment_proof_attempts_file_size_chk" CHECK ("finance_manual_payment_proof_attempts"."file_size_bytes" > 0),
	CONSTRAINT "finance_manual_payment_proof_attempts_reason_chk" CHECK ("finance_manual_payment_proof_attempts"."verdict" = 'verified' OR ("finance_manual_payment_proof_attempts"."verdict_reason" IS NOT NULL AND btrim("finance_manual_payment_proof_attempts"."verdict_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "finance_payment_instruction_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"payment_id" text NOT NULL,
	"bank_name" text,
	"account_number" text,
	"account_holder_name" text,
	"qris_r2_key" text,
	"instructions_note" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_payment_instruction_snapshots_payable_chk" CHECK ("finance_payment_instruction_snapshots"."qris_r2_key" IS NOT NULL OR ("finance_payment_instruction_snapshots"."bank_name" IS NOT NULL AND "finance_payment_instruction_snapshots"."account_number" IS NOT NULL AND "finance_payment_instruction_snapshots"."account_holder_name" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "finance_fee_disclosure_acknowledgements" ADD CONSTRAINT "finance_fee_disclosure_acknowledgements_competition_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fee_disclosure_acknowledgements" ADD CONSTRAINT "finance_fee_disclosure_acknowledgements_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fee_disclosure_acknowledgements" ADD CONSTRAINT "finance_fee_disclosure_acknowledgements_user_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fee_disclosure_acknowledgements" ADD CONSTRAINT "finance_fee_disclosure_acknowledgements_fee_rule_id_fk" FOREIGN KEY ("fee_rule_id") REFERENCES "public"."finance_fee_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_manual_payment_proof_attempts" ADD CONSTRAINT "finance_manual_payment_proof_attempts_proof_id_fk" FOREIGN KEY ("proof_id") REFERENCES "public"."finance_manual_payment_proofs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_manual_payment_proof_attempts" ADD CONSTRAINT "finance_manual_payment_proof_attempts_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."finance_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_manual_payment_proof_attempts" ADD CONSTRAINT "finance_manual_payment_proof_attempts_competition_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_manual_payment_proof_attempts" ADD CONSTRAINT "finance_manual_payment_proof_attempts_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_manual_payment_proof_attempts" ADD CONSTRAINT "finance_manual_payment_proof_attempts_reviewer_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payment_instruction_snapshots" ADD CONSTRAINT "finance_payment_instruction_snapshots_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."finance_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_fee_disclosure_acknowledgements_competition_id_idx" ON "finance_fee_disclosure_acknowledgements" USING btree ("competition_id");--> statement-breakpoint
CREATE INDEX "finance_fee_disclosure_acknowledgements_institution_id_idx" ON "finance_fee_disclosure_acknowledgements" USING btree ("institution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_manual_payment_proof_attempts_attempt_unique_idx" ON "finance_manual_payment_proof_attempts" USING btree ("proof_id","attempt_number");--> statement-breakpoint
CREATE INDEX "finance_manual_payment_proof_attempts_payment_id_idx" ON "finance_manual_payment_proof_attempts" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_payment_instruction_snapshots_payment_unique_idx" ON "finance_payment_instruction_snapshots" USING btree ("payment_id");