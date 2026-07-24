CREATE TABLE "competition_tags" (
	"competition_id" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "competition_tags_competition_id_tag_pk" PRIMARY KEY("competition_id","tag")
);
--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "eligibility_note" text;--> statement-breakpoint
ALTER TABLE "competition_tags" ADD CONSTRAINT "competition_tags_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_tags_competition_id_idx" ON "competition_tags" USING btree ("competition_id");