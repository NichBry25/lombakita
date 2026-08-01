// @vitest-environment node
//
// The retention predicate, asserted against the SQL it actually compiles to.
//
// The three conditions that bound what gets deleted live in a WHERE clause, so the mock db used by
// submission-service.test.ts — which ignores predicates entirely — cannot see them: every one of
// them could be deleted and that suite would stay green while the purge quietly widened to include
// finalized entries. Drizzle compiles a query without opening a connection, so the clause can be
// read back here with no database and no test infrastructure.
//
// This is a weaker check than seeding rows and running the query against Postgres: it proves the
// SQL says what it should, not that Postgres interprets it as intended. It is meant as the cheap
// permanent guard, not as a replacement for driving it live at 6.4-UAT.

import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  buildSubmissionPurgeDueCondition,
  resolveSubmissionPurgeCutoff,
} from "@/server/submissions/submission-service";
import { UNFINALIZED_SUBMISSION_RETENTION_GRACE_DAYS } from "@/server/submissions/submission-constants";
import { competitions } from "@/server/db/schema";

// postgres-js connects lazily and `.toSQL()` never executes, so nothing here touches a database.
const compile = (cutoff: Date) => {
  const db = drizzle(postgres("postgres://user:pass@127.0.0.1:1/unused", { max: 1 }));
  return db.select().from(competitions).where(buildSubmissionPurgeDueCondition(cutoff)).toSQL();
};

const NOW = new Date("2026-07-30T00:00:00.000Z");

describe("buildSubmissionPurgeDueCondition", () => {
  it("restricts the purge to unfinalized submissions", () => {
    expect(compile(NOW).sql).toContain('"competition_submissions"."finalized_at" is null');
  });

  // A competition with no end date has nothing to count from. Without this clause it would compare
  // NULL and be excluded by accident rather than by intent — and a future rewrite of the
  // comparison could turn that accident into a purge.
  it("requires an event end date rather than relying on NULL comparison semantics", () => {
    expect(compile(NOW).sql).toContain('"competitions"."event_end_at" is not null');
  });

  // Bound as a parameter (the driver serializes the Date to an ISO string), never interpolated
  // into the statement text.
  it("bounds the purge to events older than the cutoff, passed as a parameter", () => {
    const cutoff = resolveSubmissionPurgeCutoff(NOW);
    const compiled = compile(cutoff);
    expect(compiled.sql).toContain('"competitions"."event_end_at" < $1');
    expect(compiled.params).toEqual([cutoff.toISOString()]);
  });

  it("combines the three conditions with AND, never OR", () => {
    const sql = compile(NOW).sql;
    expect(sql).not.toMatch(/\bor\b/i);
    expect(sql.match(/\band\b/gi)?.length).toBe(2);
  });
});

describe("resolveSubmissionPurgeCutoff", () => {
  it("puts the cutoff a full grace window behind now", () => {
    const cutoff = resolveSubmissionPurgeCutoff(NOW, 90);
    expect(cutoff.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("defaults to the retention constant rather than an inlined number", () => {
    expect(resolveSubmissionPurgeCutoff(NOW).getTime()).toBe(
      resolveSubmissionPurgeCutoff(NOW, UNFINALIZED_SUBMISSION_RETENTION_GRACE_DAYS).getTime(),
    );
  });

  // A zero or negative grace would make every finished competition due immediately.
  it("never places the cutoff in the future for a positive grace", () => {
    expect(resolveSubmissionPurgeCutoff(NOW, 1).getTime()).toBeLessThan(NOW.getTime());
  });
});
