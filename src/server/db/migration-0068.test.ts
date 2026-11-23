// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0068_flow_trust_removal.sql");

describe("migration 0068", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("replaces only the function of the no-downgrade trigger", () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION "users_recruiter_tier_no_downgrade"() RETURNS trigger',
    );
    expect(sql).not.toContain("CREATE OR REPLACE TRIGGER");
    expect(sql).not.toContain("DROP ");
  });

  it("lets elevated fall to minimal only with the transaction setting on", () => {
    expect(sql).toContain(`IF OLD."recruiter_verification_tier" = 'elevated'`);
    expect(sql).toContain(`AND NEW."recruiter_verification_tier" = 'minimal'`);
    expect(sql).toContain("AND current_setting('lombakita.trust_removal', true) = 'on' THEN");
  });

  it("keeps the refusal's error text, error code and constraint name", () => {
    expect(sql).toContain("'recruiter_verification_tier cannot move backwards: % -> %',");
    expect(sql).toContain("USING ERRCODE = 'check_violation',");
    expect(sql).toContain("CONSTRAINT = 'users_recruiter_tier_no_downgrade';");
  });

  it("changes no data", () => {
    expect(sql).not.toContain("UPDATE ");
    expect(sql).not.toContain("INSERT ");
    expect(sql).not.toContain("DELETE ");
  });
});
