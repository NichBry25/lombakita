// @vitest-environment node

// Step 4.4 — Migration 0021 schema invariants.
// Live integration tests against the local DB are not part of this project's pattern, so this
// test asserts the migration text itself contains the team_id FK column, ON DELETE CASCADE,
// and the type/team_id co-presence CHECK constraint. The constraint behaviour is exercised
// against the live DB by the manual test checklist at step 9.

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = join(process.cwd(), "drizzle", "0021_many_alex_power.sql");

const text = readFileSync(MIGRATION_PATH, "utf-8");

describe("migration 0021 — competition_registrations team linkage", () => {
  it("adds the team_id column as nullable text", () => {
    expect(text).toMatch(/ALTER TABLE "competition_registrations" ADD COLUMN "team_id" text;/);
  });

  it("adds the team_id FK with ON DELETE CASCADE", () => {
    expect(text).toMatch(
      /"competition_registrations_team_id_teams_id_fk"[\s\S]*REFERENCES "public"\."teams"\("id"\) ON DELETE cascade/,
    );
  });

  it("creates an index on team_id for lookup efficiency", () => {
    expect(text).toMatch(
      /CREATE INDEX "competition_registrations_team_id_idx" ON "competition_registrations"/,
    );
  });

  it("adds the type/team_id co-presence CHECK constraint", () => {
    expect(text).toMatch(/ADD CONSTRAINT "competition_registrations_type_team_id_chk"[\s\S]*CHECK/);
    // Both branches of the CHECK present. Drizzle qualifies column refs with the table name.
    expect(text).toMatch(/"registration_type" = 'team'/);
    expect(text).toMatch(/"team_id" IS NOT NULL/);
    expect(text).toMatch(/"registration_type" = 'individual'/);
    expect(text).toMatch(/"team_id" IS NULL/);
  });
});
