// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0073_flow_one_workspace_names.sql");

describe("migration 0073", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const statementText = sql
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");

  it("is one UPDATE of the institutions table", () => {
    expect(sql.match(/^UPDATE /gm)).toEqual(["UPDATE "]);
    expect(sql).toContain('UPDATE "institutions"');
  });

  it("names only personal rows that store no name", () => {
    expect(sql).toContain(`WHERE "institution_type" = 'personal'`);
    expect(sql).toContain(`  AND "display_name" IS NULL;`);
  });

  it("writes the neutral name and reads no username", () => {
    expect(sql).toContain(`SET "display_name" = 'Ruang kerja pribadi'`);
    expect(statementText).not.toContain("updated_at");
    expect(statementText).not.toContain("username");
    expect(statementText).not.toContain('"users"');
  });

  it("changes no schema and removes nothing", () => {
    expect(sql).not.toMatch(/^(CREATE|ALTER|DROP|DELETE|INSERT|TRUNCATE) /m);
  });
});
