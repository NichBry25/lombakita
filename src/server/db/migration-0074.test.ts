// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0074_flow_one_workspace_name_required.sql");

describe("migration 0074", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("drops the name CHECK and makes display_name required, and nothing else", () => {
    const statements = sql
      .split("--> statement-breakpoint")
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0)
      .sort();

    expect(statements).toEqual([
      'ALTER TABLE "institutions" ALTER COLUMN "display_name" SET NOT NULL;',
      'ALTER TABLE "institutions" DROP CONSTRAINT "institutions_display_name_type_chk";',
    ]);
  });
});
