CREATE TABLE "institution_social_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"institution_id" text NOT NULL,
	"platform" "profile_social_platform" NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "logo_r2_key" text;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "about" text;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "institution_social_links" ADD CONSTRAINT "institution_social_links_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "institution_social_links_institution_id_idx" ON "institution_social_links" USING btree ("institution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_social_links_institution_platform_unique_idx" ON "institution_social_links" USING btree ("institution_id","platform");