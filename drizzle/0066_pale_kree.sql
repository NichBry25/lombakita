CREATE TYPE "public"."competition_audience" AS ENUM('umum', 'mahasiswa', 'sma_smk', 'smp', 'sd');--> statement-breakpoint
CREATE TYPE "public"."competition_location" AS ENUM('online', 'offline', 'hybrid');--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "location" "competition_location";--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "audience" "competition_audience"[];