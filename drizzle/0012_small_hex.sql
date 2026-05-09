CREATE TABLE "competition_saves" (
	"user_id" text NOT NULL,
	"competition_id" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_saves_user_id_competition_id_pk" PRIMARY KEY("user_id","competition_id")
);
--> statement-breakpoint
ALTER TABLE "competition_saves" ADD CONSTRAINT "competition_saves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_saves" ADD CONSTRAINT "competition_saves_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_saves_user_id_idx" ON "competition_saves" USING btree ("user_id");