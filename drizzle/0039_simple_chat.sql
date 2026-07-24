CREATE TABLE "competition_prizes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"competition_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"rank_label" text,
	"title" text NOT NULL,
	"description" text,
	"cash_amount" numeric(12, 2),
	"is_certificate" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_prizes_cash_amount_non_negative_chk" CHECK ("competition_prizes"."cash_amount" IS NULL OR "competition_prizes"."cash_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "competition_prizes" ADD CONSTRAINT "competition_prizes_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_prizes_competition_id_idx" ON "competition_prizes" USING btree ("competition_id");