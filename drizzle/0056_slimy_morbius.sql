CREATE TYPE "public"."finance_payment_event_actor" AS ENUM('system', 'gateway', 'user');--> statement-breakpoint
CREATE TYPE "public"."finance_payment_event_type" AS ENUM('initiated', 'succeeded', 'failed', 'expired', 'refunded', 'corrected');--> statement-breakpoint
CREATE TYPE "public"."finance_payment_subject" AS ENUM('competition_registration');--> statement-breakpoint
CREATE TABLE "finance_fee_rules" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"institution_id" text,
	"currency" text NOT NULL,
	"basis_points" integer DEFAULT 0 NOT NULL,
	"flat_amount" bigint DEFAULT 0 NOT NULL,
	"minimum_fee_amount" bigint,
	"maximum_fee_amount" bigint,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_fee_rules_currency_chk" CHECK ("finance_fee_rules"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_fee_rules_basis_points_chk" CHECK ("finance_fee_rules"."basis_points" >= 0 AND "finance_fee_rules"."basis_points" <= 10000),
	CONSTRAINT "finance_fee_rules_flat_amount_chk" CHECK ("finance_fee_rules"."flat_amount" >= 0),
	CONSTRAINT "finance_fee_rules_bounds_chk" CHECK (("finance_fee_rules"."minimum_fee_amount" IS NULL OR "finance_fee_rules"."minimum_fee_amount" >= 0) AND ("finance_fee_rules"."maximum_fee_amount" IS NULL OR "finance_fee_rules"."maximum_fee_amount" >= 0) AND ("finance_fee_rules"."minimum_fee_amount" IS NULL OR "finance_fee_rules"."maximum_fee_amount" IS NULL OR "finance_fee_rules"."minimum_fee_amount" <= "finance_fee_rules"."maximum_fee_amount")),
	CONSTRAINT "finance_fee_rules_window_chk" CHECK ("finance_fee_rules"."effective_to" IS NULL OR "finance_fee_rules"."effective_to" > "finance_fee_rules"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "finance_payment_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"payment_id" text NOT NULL,
	"event_type" "finance_payment_event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"amount" bigint,
	"currency" text,
	"actor_type" "finance_payment_event_actor" NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"metadata" jsonb,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "finance_payment_events_amount_currency_chk" CHECK (("finance_payment_events"."amount" IS NULL AND "finance_payment_events"."currency" IS NULL) OR ("finance_payment_events"."amount" IS NOT NULL AND "finance_payment_events"."currency" IS NOT NULL AND "finance_payment_events"."currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "finance_payment_events_amount_sign_chk" CHECK ("finance_payment_events"."amount" IS NULL OR "finance_payment_events"."amount" >= 0 OR "finance_payment_events"."event_type" = 'corrected'),
	CONSTRAINT "finance_payment_events_reason_required_chk" CHECK ("finance_payment_events"."event_type" NOT IN ('refunded', 'corrected') OR ("finance_payment_events"."reason" IS NOT NULL AND btrim("finance_payment_events"."reason") <> '')),
	CONSTRAINT "finance_payment_events_actor_chk" CHECK (("finance_payment_events"."actor_type" = 'user' AND "finance_payment_events"."actor_user_id" IS NOT NULL) OR ("finance_payment_events"."actor_type" <> 'user' AND "finance_payment_events"."actor_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "finance_payments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"payer_user_id" text NOT NULL,
	"receiving_institution_id" text NOT NULL,
	"subject_type" "finance_payment_subject" NOT NULL,
	"competition_registration_id" text,
	"currency" text NOT NULL,
	"gross_amount" bigint NOT NULL,
	"fee_rule_id" text NOT NULL,
	"fee_basis_points" integer NOT NULL,
	"fee_flat_amount" bigint NOT NULL,
	"platform_fee_amount" bigint NOT NULL,
	"institution_net_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_payments_subject_xor_chk" CHECK (("finance_payments"."subject_type" = 'competition_registration' AND "finance_payments"."competition_registration_id" IS NOT NULL)),
	CONSTRAINT "finance_payments_currency_chk" CHECK ("finance_payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_payments_gross_amount_chk" CHECK ("finance_payments"."gross_amount" >= 0),
	CONSTRAINT "finance_payments_fee_snapshot_chk" CHECK ("finance_payments"."fee_basis_points" >= 0 AND "finance_payments"."fee_basis_points" <= 10000 AND "finance_payments"."fee_flat_amount" >= 0 AND "finance_payments"."platform_fee_amount" >= 0 AND "finance_payments"."institution_net_amount" >= 0),
	CONSTRAINT "finance_payments_split_balance_chk" CHECK ("finance_payments"."platform_fee_amount" + "finance_payments"."institution_net_amount" = "finance_payments"."gross_amount")
);
--> statement-breakpoint
ALTER TABLE "finance_fee_rules" ADD CONSTRAINT "finance_fee_rules_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payment_events" ADD CONSTRAINT "finance_payment_events_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."finance_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payment_events" ADD CONSTRAINT "finance_payment_events_actor_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_payer_user_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_receiving_institution_id_fk" FOREIGN KEY ("receiving_institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_competition_registration_id_fk" FOREIGN KEY ("competition_registration_id") REFERENCES "public"."competition_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_fee_rule_id_fk" FOREIGN KEY ("fee_rule_id") REFERENCES "public"."finance_fee_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_fee_rules_scope_effective_idx" ON "finance_fee_rules" USING btree ("institution_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_payment_events_idempotency_key_idx" ON "finance_payment_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "finance_payment_events_payment_occurred_idx" ON "finance_payment_events" USING btree ("payment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "finance_payments_receiving_institution_id_idx" ON "finance_payments" USING btree ("receiving_institution_id");--> statement-breakpoint
CREATE INDEX "finance_payments_payer_user_id_idx" ON "finance_payments" USING btree ("payer_user_id");--> statement-breakpoint
CREATE INDEX "finance_payments_competition_registration_id_idx" ON "finance_payments" USING btree ("competition_registration_id");