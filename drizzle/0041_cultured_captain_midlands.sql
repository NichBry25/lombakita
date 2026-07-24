CREATE TYPE "public"."competition_review_status" AS ENUM('visible', 'hidden');--> statement-breakpoint
CREATE TABLE "competition_reviews" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"competition_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"body" text,
	"status" "competition_review_status" DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_reviews_rating_range_chk" CHECK ("competition_reviews"."rating" >= 1 AND "competition_reviews"."rating" <= 5)
);
--> statement-breakpoint
ALTER TABLE "competition_reviews" ADD CONSTRAINT "competition_reviews_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_reviews" ADD CONSTRAINT "competition_reviews_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_reviews_competition_id_idx" ON "competition_reviews" USING btree ("competition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competition_reviews_competition_author_unique_idx" ON "competition_reviews" USING btree ("competition_id","author_user_id");