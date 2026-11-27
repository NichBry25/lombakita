ALTER TABLE "institutions" DROP CONSTRAINT "institutions_display_name_type_chk";--> statement-breakpoint
ALTER TABLE "institutions" ALTER COLUMN "display_name" SET NOT NULL;