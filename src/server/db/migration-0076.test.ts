// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0076_flow_tick_checks.sql");

describe("migration 0076", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("adds one column to institutions and two to the submissions", () => {
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(3);
    expect(sql).toContain(
      `ALTER TABLE "institution_verification_submissions" ADD COLUMN "requested_path" "institution_tick_path" DEFAULT 'documents' NOT NULL;`,
    );
    expect(sql).toContain(
      `ALTER TABLE "institution_verification_submissions" ADD COLUMN "instagram_url" text;`,
    );
    expect(sql).toContain(
      `ALTER TABLE "institutions" ADD COLUMN "name_checked_at" timestamp with time zone;`,
    );
  });

  it("adds the seven checks with their exact expressions", () => {
    expect(sql.match(/ADD CONSTRAINT/g)).toHaveLength(7);
    expect(sql).toContain(
      `ALTER TABLE "institution_verification_submissions" ADD CONSTRAINT "institution_verification_submissions_requested_path_chk" CHECK ("institution_verification_submissions"."requested_path" IN ('instagram', 'documents'))`,
    );
    expect(sql).toContain(
      `ALTER TABLE "institution_verification_submissions" ADD CONSTRAINT "institution_verification_submissions_instagram_chk" CHECK (("institution_verification_submissions"."requested_path" = 'instagram') = ("institution_verification_submissions"."instagram_url" IS NOT NULL))`,
    );
    expect(sql).toContain(
      `ALTER TABLE "institutions" ADD CONSTRAINT "institutions_tick_path_verified_chk" CHECK ("institutions"."tick_path" IS NULL OR "institutions"."verification_status" = 'verified')`,
    );
    expect(sql).toContain(
      `ALTER TABLE "institutions" ADD CONSTRAINT "institutions_tick_domain_path_chk" CHECK ("institutions"."tick_domain" IS NULL OR "institutions"."tick_path" IS NOT DISTINCT FROM 'domain')`,
    );
    expect(sql).toContain(
      `ALTER TABLE "institutions" ADD CONSTRAINT "institutions_name_proof_path_chk" CHECK (("institutions"."name_proof_due_at" IS NULL AND "institutions"."name_checked_at" IS NULL) OR "institutions"."tick_path" IS NOT DISTINCT FROM 'domain')`,
    );
    expect(sql).toContain(
      `ALTER TABLE "institutions" ADD CONSTRAINT "institutions_name_proof_reminder_chk" CHECK ("institutions"."name_proof_reminded_at" IS NULL OR "institutions"."name_proof_due_at" IS NOT NULL)`,
    );
    expect(sql).toContain(
      `ALTER TABLE "institutions" ADD CONSTRAINT "institutions_name_check_or_proof_chk" CHECK ("institutions"."name_checked_at" IS NULL OR "institutions"."name_proof_due_at" IS NULL)`,
    );
  });

  it("drops, renames and updates nothing", () => {
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("RENAME");
    expect(sql).not.toContain("ALTER COLUMN");
    expect(sql).not.toContain("ALTER TYPE");
    expect(sql).not.toContain("UPDATE ");
  });
});
