// @vitest-environment node
//
// What "publicly visible" means, asserted against the SQL it actually compiles to.
//
// The three conditions live in a WHERE clause, and the mock db used by
// competition-public-service.test.ts ignores predicates entirely — it resolves whatever rows the
// fixture hands it. Any one of these clauses could be deleted and that suite would stay green
// while unpublished, soft-deleted, or suspended-organizer competitions leaked into the public
// listing, the featured rail, and the detail page. Drizzle compiles a query without opening a
// connection, so the clause can be read back here with no database and no test infrastructure.
//
// This proves the SQL says what it should, not that Postgres interprets it as intended. Driving a
// suspended institution end to end stays a manual/UAT check.

import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { buildPublicVisibilityCondition } from "@/server/competitions/competition-public-service";
import { competitions, institutions } from "@/server/db/schema";

// postgres-js connects lazily and `.toSQL()` never executes, so nothing here touches a database.
const compile = () => {
  const db = drizzle(postgres("postgres://user:pass@127.0.0.1:1/unused", { max: 1 }));
  return db
    .select()
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(buildPublicVisibilityCondition())
    .toSQL();
};

describe("buildPublicVisibilityCondition", () => {
  it("restricts public reads to published competitions", () => {
    expect(compile().sql).toContain('"competitions"."status" = ');
  });

  it("excludes soft-deleted competitions", () => {
    expect(compile().sql).toContain('"competitions"."deleted_at" is null');
  });

  // The clause this file exists for. A suspended institution's own page is withheld; without this,
  // its competitions kept serving publicly, so the two halves disagreed about what suspension
  // means to the public.
  it("excludes competitions whose organizing institution is suspended", () => {
    expect(compile().sql).toContain('"institutions"."suspended_at" is null');
  });

  it("binds the published status as a parameter rather than interpolating it", () => {
    expect(compile().params).toContain("published");
  });
});
