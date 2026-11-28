// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0075_flow_tick_paths.sql");

describe("migration 0075", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("is two UPDATEs of institutions", () => {
    expect(sql.match(/^UPDATE /gm)).toHaveLength(2);
    expect(sql).toContain('UPDATE "institutions" AS i');
    expect(sql).toContain(`UPDATE "institutions"\nSET "tick_path" = 'staff'`);
  });

  it("gives documents only to verified rows with no path and an approved request", () => {
    expect(sql).toContain(`SET "tick_path" = 'documents'`);
    expect(sql).toContain(`WHERE i."verification_status" = 'verified'`);
    expect(sql).toContain(`  AND i."tick_path" IS NULL`);
    expect(sql).toContain(`    WHERE s."institution_id" = i."id"`);
    expect(sql).toContain(`      AND s."status" = 'approved'`);
  });

  it("gives staff to every other verified row with no path, after the documents statement", () => {
    expect(sql).toContain(`WHERE "verification_status" = 'verified'`);
    expect(sql).toContain(`  AND "tick_path" IS NULL;`);
    expect(sql.indexOf("'documents'")).toBeLessThan(sql.indexOf("'staff'"));
  });

  it("changes no schema, removes nothing and bumps no timestamp", () => {
    expect(sql).not.toMatch(/^(CREATE|ALTER|DROP|DELETE|INSERT|TRUNCATE) /m);
    expect(sql).not.toContain("updated_at");
    expect(sql).not.toContain("verified_at");
  });
});
