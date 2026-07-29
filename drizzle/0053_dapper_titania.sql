CREATE TYPE "public"."registration_document_request_status" AS ENUM('requested', 'submitted', 'accepted', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "competition_document_request_files" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"request_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"original_file_name" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_document_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"registration_id" text NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"due_at" timestamp with time zone NOT NULL,
	"status" "registration_document_request_status" DEFAULT 'requested' NOT NULL,
	"requested_by_user_id" text,
	"submitted_at" timestamp with time zone,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competition_document_request_files" ADD CONSTRAINT "competition_document_request_files_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."competition_document_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_document_requests" ADD CONSTRAINT "competition_document_requests_registration_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."competition_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_document_requests" ADD CONSTRAINT "competition_document_requests_requested_by_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_document_requests" ADD CONSTRAINT "competition_document_requests_reviewed_by_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_document_request_files_request_id_idx" ON "competition_document_request_files" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "competition_document_requests_registration_id_idx" ON "competition_document_requests" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competition_document_requests_open_unique_idx" ON "competition_document_requests" USING btree ("registration_id") WHERE "competition_document_requests"."status" in ('requested', 'submitted');