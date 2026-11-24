// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0069_flow_schema_check_fixes.sql");

describe("migration 0069", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("drops only the two checks it replaces", () => {
    const drops = sql.match(/DROP [A-Z]+ "[a-z_]+"/g) ?? [];
    expect(drops).toEqual([
      'DROP CONSTRAINT "competition_reports_note_required_chk"',
      'DROP CONSTRAINT "host_organization_emails_email_domain_chk"',
    ]);
  });

  it("refuses a blank note on a lainnya report", () => {
    expect(sql).toContain(
      `ADD CONSTRAINT "competition_reports_note_required_chk" CHECK ("competition_reports"."reason" <> 'lainnya' OR ("competition_reports"."note" IS NOT NULL AND btrim("competition_reports"."note") <> ''));`,
    );
  });

  it("matches the domain by exact split, not by LIKE", () => {
    expect(sql).toContain(
      `ADD CONSTRAINT "host_organization_emails_email_domain_chk" CHECK ("host_organization_emails"."email" ~ '^[^@]+@[^@]+$' AND "host_organization_emails"."domain" = split_part("host_organization_emails"."email", '@', 2));`,
    );
    expect(sql).not.toContain("LIKE");
  });

  it("stores a challenge email only in its normalized form", () => {
    expect(sql).toContain(
      `ADD CONSTRAINT "organization_email_challenges_email_normalized_chk" CHECK ("organization_email_challenges"."email" = lower(btrim("organization_email_challenges"."email")));`,
    );
  });

  it("changes no data and renames nothing", () => {
    expect(sql).not.toMatch(/^UPDATE /m);
    expect(sql).not.toContain("RENAME");
    expect(sql).not.toContain("ALTER COLUMN");
  });
});
