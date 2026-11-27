CREATE TABLE "host_trust_removals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text,
	"removed_at" timestamp with time zone NOT NULL,
	"organization_domain" text,
	"email_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"phone_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"key_check" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_trust_removals_organization_domain_lower_chk" CHECK ("host_trust_removals"."organization_domain" = lower("host_trust_removals"."organization_domain")),
	CONSTRAINT "host_trust_removals_email_hashes_hex_chk" CHECK (array_to_string("host_trust_removals"."email_hashes", ',', 'null') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$' and length(array_to_string("host_trust_removals"."email_hashes", '')) = 64 * cardinality("host_trust_removals"."email_hashes")),
	CONSTRAINT "host_trust_removals_phone_hashes_hex_chk" CHECK (array_to_string("host_trust_removals"."phone_hashes", ',', 'null') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$' and length(array_to_string("host_trust_removals"."phone_hashes", '')) = 64 * cardinality("host_trust_removals"."phone_hashes")),
	CONSTRAINT "host_trust_removals_key_check_hex_chk" CHECK ("host_trust_removals"."key_check" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "host_trust_removals" ADD CONSTRAINT "host_trust_removals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "host_trust_removals_user_id_unique_idx" ON "host_trust_removals" USING btree ("user_id") WHERE "host_trust_removals"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "host_trust_removals_removed_at_idx" ON "host_trust_removals" USING btree ("removed_at");