// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(process.cwd(), "drizzle/0071_flow_host_trust_close_requests.sql");

describe("migration 0071", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("is one UPDATE of the host request table", () => {
    expect(sql.match(/^UPDATE /gm)).toEqual(["UPDATE "]);
    expect(sql).toContain('UPDATE "recruiter_verification_submissions"');
  });

  it("closes only open rows of the old flow", () => {
    expect(sql).toContain(`WHERE "status" IN ('draft', 'pending_review')`);
    expect(sql).toContain(`  AND "competition_id" IS NULL;`);
  });

  it("writes the fixed reason and closes the rows", () => {
    expect(sql).toContain(`SET "status" = 'rejected',`);
    expect(sql).toContain(`"rejection_reason" = 'Ditutup karena alur penyelenggara berubah.',`);
    expect(sql).toContain(`"resubmission_allowed" = false,`);
    expect(sql).toContain(`"reviewed_at" = now()`);
  });

  it("changes no schema and removes nothing", () => {
    expect(sql).not.toMatch(/^(CREATE|ALTER|DROP|DELETE|INSERT|TRUNCATE) /m);
  });
});
