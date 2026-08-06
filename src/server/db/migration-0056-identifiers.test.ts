// @vitest-environment node
//
// Postgres truncates any identifier over NAMEDATALEN-1 = 63 characters, and does it with a NOTICE
// rather than an error — so the constraint or index gets created under a name that no longer
// matches schema.ts, and the next `drizzle-kit generate` reads the difference as a phantom pending
// change.
//
// Scoped to migration 0056 deliberately. A repo-wide assertion would fail on 0051's SQL, which
// still contains an over-long name as shipped history and must not be edited.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MAX_IDENTIFIER_LENGTH = 63;
const MIGRATION = resolve(process.cwd(), "drizzle/0056_slimy_morbius.sql");

// CONSTRAINT "x", CREATE [UNIQUE] INDEX "x", CREATE TABLE "x", CREATE TYPE "public"."x"
const DECLARED_IDENTIFIER =
  /(?:CONSTRAINT|CREATE TABLE|CREATE TYPE|CREATE INDEX|CREATE UNIQUE INDEX)\s+(?:"public"\.)?"([^"]+)"/g;

describe("migration 0056 identifiers", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const names = [...sql.matchAll(DECLARED_IDENTIFIER)].map((match) => match[1]!);

  it("declares the finance objects this step ships", () => {
    // Without this the length check below could pass by matching nothing at all.
    expect(names).toContain("finance_payments");
    expect(names).toContain("finance_payment_events");
    expect(names).toContain("finance_fee_rules");
    expect(names.length).toBeGreaterThan(20);
  });

  it("keeps every declared name inside Postgres's 63-character limit", () => {
    const overLong = names.filter((name) => name.length > MAX_IDENTIFIER_LENGTH);

    expect(overLong).toEqual([]);
  });
});
