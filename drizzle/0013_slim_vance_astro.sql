CREATE TYPE "public"."student_education_level" AS ENUM('D3', 'D4', 'S1', 'S2', 'S3');--> statement-breakpoint
CREATE TYPE "public"."student_enrollment_status" AS ENUM('enrolled', 'on_leave', 'graduated', 'unknown');--> statement-breakpoint
CREATE TABLE "student_eligibility_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"date_of_birth" date,
	"enrollment_status" "student_enrollment_status",
	"education_level" "student_education_level",
	"university_name" text,
	"student_id_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_eligibility_profiles" ADD CONSTRAINT "student_eligibility_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;