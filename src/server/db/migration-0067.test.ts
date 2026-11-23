// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0067_flow_simplification_tables.sql");

const NEW_COLUMNS = [
  'ALTER TABLE "competitions" ADD COLUMN "frozen_at" timestamp with time zone;',
  'ALTER TABLE "competitions" ADD COLUMN "frozen_reason" text;',
  'ALTER TABLE "competitions" ADD COLUMN "frozen_by_user_id" text;',
  'ALTER TABLE "competitions" ADD COLUMN "date_check_required_at" timestamp with time zone;',
  'ALTER TABLE "institutions" ADD COLUMN "tick_path" "institution_tick_path";',
  'ALTER TABLE "institutions" ADD COLUMN "tick_domain" text;',
  'ALTER TABLE "institutions" ADD COLUMN "name_proof_due_at" timestamp with time zone;',
  'ALTER TABLE "institutions" ADD COLUMN "name_proof_reminded_at" timestamp with time zone;',
  'ALTER TABLE "recruiter_verification_submissions" ADD COLUMN "competition_id" text;',
  'ALTER TABLE "recruiter_verification_submissions" ADD COLUMN "guideline_item" text;',
  'ALTER TABLE "users" ADD COLUMN "host_trust_removed_at" timestamp with time zone;',
];

describe("migration 0067", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("creates the two enums with their values in order", () => {
    expect(sql).toContain(
      "CREATE TYPE \"public\".\"competition_report_status\" AS ENUM('open', 'closed', 'actioned');",
    );
    expect(sql).toContain(
      "CREATE TYPE \"public\".\"institution_tick_path\" AS ENUM('domain', 'instagram', 'documents', 'staff');",
    );
  });

  it("creates the three new tables", () => {
    expect(sql).toContain('CREATE TABLE "competition_reports" (');
    expect(sql).toContain('CREATE TABLE "host_organization_emails" (');
    expect(sql).toContain('CREATE TABLE "organization_email_challenges" (');
  });

  it("adds every new column of an existing table as nullable", () => {
    for (const statement of NEW_COLUMNS) {
      expect(sql).toContain(statement);
    }
  });

  it("drops only the cancellation check, and adds it back with the fraud arm last", () => {
    const drops = sql.match(/DROP [A-Z]+ "[a-z_]+"/g) ?? [];
    expect(drops).toEqual(['DROP CONSTRAINT "competitions_cancellation_state_chk"']);
    expect(sql).toContain(
      'OR ("competitions"."cancelled_at" IS NOT NULL AND "competitions"."cancellation_reason" = \'fraud\'));',
    );
  });

  it("keeps the old arms of the cancellation check word for word", () => {
    const previous = readFileSync(
      resolve(process.cwd(), "drizzle/0055_add_competition_participation_decisions.sql"),
      "utf8",
    );
    const oldCheck = previous.match(/CHECK \((.*insufficient_participants.*)\);/)?.[1] ?? "";
    expect(oldCheck).not.toBe("");
    expect(sql).toContain(`CHECK (${oldCheck} OR (`);
  });

  it("changes no data and renames nothing", () => {
    expect(sql).not.toMatch(/^UPDATE /m);
    expect(sql).not.toContain("RENAME");
    expect(sql).not.toContain("ALTER COLUMN");
  });
});
