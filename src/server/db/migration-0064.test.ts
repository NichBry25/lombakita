// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0064_unpublish_fresh_start.sql");

describe("migration 0064", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("adds the publication's close to registrations, nullable", () => {
    expect(sql).toContain(
      'ALTER TABLE "competition_registrations" ADD COLUMN "publication_closed_at" timestamp with time zone;',
    );
    expect(sql).not.toContain("NOT NULL");
  });

  it("lets a cancelled team give up its name", () => {
    expect(sql).toContain('DROP INDEX "teams_competition_id_name_unique_idx";');
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "teams_competition_id_name_unique_idx" ON "teams" USING btree ("competition_id","name") WHERE "teams"."status" <> 'cancelled';`,
    );
  });

  it("writes no row and drops no column or table", () => {
    expect(sql).not.toContain("UPDATE ");
    expect(sql).not.toContain("DELETE ");
    expect(sql).not.toContain("DROP COLUMN");
    expect(sql).not.toContain("DROP TABLE");
  });
});
