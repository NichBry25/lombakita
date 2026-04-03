CREATE TABLE "infrastructure_probe" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infrastructure_probe_key_unique" UNIQUE("key")
);
