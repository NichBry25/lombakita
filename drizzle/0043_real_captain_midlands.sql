ALTER TABLE "competitions" ALTER COLUMN "category" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."competition_category";--> statement-breakpoint
CREATE TYPE "public"."competition_category" AS ENUM('hackathon', 'scientific_writing', 'essay', 'debate', 'olympiad', 'business', 'engineering', 'finance', 'law', 'design', 'data_science', 'programming', 'marketing', 'digital_art', 'infographics', 'performing_arts', 'esports', 'quiz', 'other');--> statement-breakpoint
ALTER TABLE "competitions" ALTER COLUMN "category" SET DATA TYPE "public"."competition_category" USING (
  CASE
    WHEN "category" IS NULL THEN NULL
    WHEN "category" = 'business' THEN 'business'
    WHEN "category" = 'sports' THEN 'esports'
    ELSE 'other'
  END::"public"."competition_category"
);