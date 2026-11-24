// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0070_flow_trust_removal_txid.sql");

describe("migration 0070", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("replaces only the function of the no-downgrade trigger", () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION "users_recruiter_tier_no_downgrade"() RETURNS trigger',
    );
    expect(sql).not.toContain("CREATE OR REPLACE TRIGGER");
    expect(sql).not.toContain("DROP ");
  });

  it("lets elevated fall to minimal only when the setting holds this transaction's id", () => {
    expect(sql).toContain(`IF OLD."recruiter_verification_tier" = 'elevated'`);
    expect(sql).toContain(`AND NEW."recruiter_verification_tier" = 'minimal'`);
    expect(sql).toContain(
      "AND current_setting('lombakita.trust_removal', true) = txid_current()::text THEN",
    );
    expect(sql).not.toContain("= 'on'");
  });

  it("keeps the refusal's error text, error code and constraint name", () => {
    expect(sql).toContain("'recruiter_verification_tier cannot move backwards: % -> %',");
    expect(sql).toContain("USING ERRCODE = 'check_violation',");
    expect(sql).toContain("CONSTRAINT = 'users_recruiter_tier_no_downgrade';");
  });

  it("changes no data", () => {
    expect(sql).not.toMatch(/^UPDATE /m);
    expect(sql).not.toMatch(/^INSERT /m);
    expect(sql).not.toMatch(/^DELETE /m);
  });
});
