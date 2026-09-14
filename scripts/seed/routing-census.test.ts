/**
 * The gate over the seed's write population.
 *
 * The census itself is exercised against FIXTURE SOURCE built in this file, so what the classifier
 * does is pinned independently of what the seed currently happens to contain. Otherwise the only
 * assertion would be a number, and a number agrees with whatever produced it.
 *
 * The ratchet is then asserted against the real files, exactly, in both directions.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FINANCE_LANE_TABLES } from "./manual-payment-lane";
import {
  CensusRefusal,
  SEED_FILE_OBLIGATIONS,
  censusWriteSites,
  summariseCensus,
} from "./routing-census";

const workspace = mkdtempSync(join(tmpdir(), "routing-census-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Writes one throwaway module and returns its census. */
const censusOf = (name: string, source: string) => {
  const file = join(workspace, name);
  writeFileSync(file, source);

  return summariseCensus(censusWriteSites(file));
};

describe("what the census counts as a raw write", () => {
  // The form LAUNCH-D5's measurement missed. A census that counts `.insert(table)` calls reports
  // ZERO here, which is how the largest direct-insert fixture in the repository was left out of a
  // population that claimed to be complete.
  it("counts a raw INSERT in a tagged template", () => {
    const census = censusOf(
      "raw-insert.ts",
      "const go = async (sql: any) => { await sql`INSERT INTO institutions (id) VALUES ('x')`; };",
    );

    expect(census.raw).toBe(1);
    expect(census.rawTables).toEqual(["institutions"]);
  });

  it("counts UPDATE and DELETE, not only INSERT", () => {
    const census = censusOf(
      "raw-verbs.ts",
      "const go = async (sql: any) => {\n" +
        "  await sql`UPDATE competitions SET title = 'x'`;\n" +
        "  await sql`DELETE FROM teams WHERE id = 'y'`;\n" +
        "};",
    );

    expect(census.raw).toBe(2);
    expect(census.rawTables).toEqual(["competitions", "teams"]);
  });

  // A statement split across lines defeats a line-window regex and not an AST walk.
  it("counts a write whose statement spans several lines", () => {
    const census = censusOf(
      "multiline.ts",
      "const go = async (sql: any) => {\n" +
        "  await sql`\n    INSERT INTO\n      competition_prizes (id)\n    VALUES ('x')\n  `;\n" +
        "};",
    );

    expect(census.raw).toBe(1);
  });

  it("counts a drizzle builder write naming a schema table", () => {
    const census = censusOf(
      "builder.ts",
      'import { users } from "@/server/db/schema";\n' +
        "const go = async (db: any) => { await db.insert(users).values({}); };",
    );

    expect(census.raw).toBe(1);
    expect(census.rawTables).toEqual(["users"]);
  });

  // A READ is not a write. A seed that queries directly to assert a post-condition is doing the
  // right thing; routing its reads through services would make the assertion measure the service.
  it("does not count a SELECT", () => {
    const census = censusOf(
      "select.ts",
      "const go = async (sql: any) => { await sql`SELECT count(*) FROM institutions`; };",
    );

    expect(census.raw).toBe(0);
  });

  // Both of these were reported as writes on the first run, to tables named `mfaSecret` and `raw`.
  // Node's crypto objects carry an `update` method, and so does most of the stream-shaped standard
  // library, so the method name alone identifies nothing.
  it("does not count crypto .update() as a database write", () => {
    const census = censusOf(
      "crypto.ts",
      "const go = (cipher: any, hash: any, secret: string, raw: string) => {\n" +
        "  cipher.update(secret);\n" +
        "  hash.update(raw);\n" +
        "};",
    );

    expect(census.raw).toBe(0);
  });
});

describe("what the census counts as a raw write, continued", () => {
  it("counts a builder write that reaches the table through a schema namespace", () => {
    const census = censusOf(
      "namespace.ts",
      'import * as schema from "@/server/db/schema";\n' +
        "const go = async (db: any) => { await db.delete(schema.teams); };",
    );

    expect(census.raw).toBe(1);
    expect(census.rawTables).toEqual(["teams"]);
  });

  // `DO UPDATE SET` is part of the INSERT it belongs to. With the statement anchor removed from
  // the write pattern, every upsert in every seed reads as two statements and is refused.
  it("counts an upsert once, against the table it inserts into", () => {
    const census = censusOf(
      "upsert.ts",
      "const go = async (sql: any) => {\n" +
        "  await sql`INSERT INTO users (id) VALUES ('x') ON CONFLICT (id) DO UPDATE SET name = 'y'`;\n" +
        "};",
    );

    expect(census.raw).toBe(1);
    expect(census.rawTables).toEqual(["users"]);
  });

  it("counts TRUNCATE as the write it is", () => {
    const census = censusOf(
      "truncate.ts",
      "const go = async (sql: any) => { await sql`TRUNCATE TABLE notifications`; };",
    );

    expect(census.rawTables).toEqual(["notifications"]);
  });
});

/**
 * Rule 38. Each of these was run through the census as it stood before the refusal existed. It
 * scored ZERO on `.unsafe()`, on the plain string, on the untagged template and on the namespace
 * builder write; it named a table `WHERE` for the substituted one; it counted the two-statement
 * template as one; and it found the CTE's inner DELETE only because its pattern was not anchored
 * to a statement start. In every case the file would have met its ceiling while holding a write
 * that was not counted, or was counted against the wrong thing.
 */
describe("what the census refuses to classify", () => {
  const refusalFrom = (name: string, source: string): string => {
    try {
      censusOf(name, source);
    } catch (error) {
      expect(error).toBeInstanceOf(CensusRefusal);
      return (error as Error).message;
    }

    throw new Error(`the census classified ${name} instead of refusing it`);
  };

  it("refuses a write whose table is a substitution", () => {
    const message = refusalFrom(
      "dynamic-table.ts",
      "const go = async (sql: any, t: string) => { await sql`DELETE FROM ${sql(t)} WHERE 1 = 1`; };",
    );

    expect(message).toMatch(
      /dynamic-table\.ts:1: the table this statement writes is a substitution/,
    );
  });

  // A read with a substituted table is the money lane's own row count. Reads are not this gate's
  // business and a substitution in one is not a write to nowhere.
  it("does not refuse a read whose table is a substitution", () => {
    const census = censusOf(
      "dynamic-read.ts",
      "const go = async (sql: any, t: string) => { await sql`SELECT count(*) FROM ${sql(t)}`; };",
    );

    expect(census.raw).toBe(0);
  });

  it("refuses two statements in one template", () => {
    const message = refusalFrom(
      "two-statements.ts",
      "const go = async (sql: any) => {\n" +
        "  await sql`DELETE FROM teams WHERE id = 'a'; DELETE FROM users WHERE id = 'b'`;\n" +
        "};",
    );

    expect(message).toMatch(/two-statements\.ts:2: one template holds 2 write statements/);
  });

  it("refuses a CTE, which can carry a write the census does not count", () => {
    const message = refusalFrom(
      "cte.ts",
      "const go = async (sql: any) => {\n" +
        "  await sql`WITH gone AS (DELETE FROM teams RETURNING id) SELECT count(*) FROM gone`;\n" +
        "};",
    );

    expect(message).toMatch(/cte\.ts:2: a statement leading with WITH/);
  });

  it("refuses `.unsafe()`, whatever it is given", () => {
    const message = refusalFrom(
      "unsafe.ts",
      "const go = async (sql: any, q: string) => { await sql.unsafe(q); };",
    );

    expect(message).toMatch(/unsafe\.ts:1: `\.unsafe\(\)` runs whatever string/);
  });

  it("refuses a write statement carried in a plain string", () => {
    const message = refusalFrom(
      "string-sql.ts",
      'const go = async (client: any) => { await client.query("INSERT INTO users (id) VALUES (1)"); };',
    );

    expect(message).toMatch(/string-sql\.ts:1: a write statement in a plain string/);
  });

  it("refuses a write statement carried in an untagged template", () => {
    const message = refusalFrom(
      "untagged.ts",
      "const go = async (client: any, id: string) => {\n" +
        "  await client.query(`UPDATE users SET name = 'x' WHERE id = ${id}`);\n" +
        "};",
    );

    expect(message).toMatch(/untagged\.ts:2: a write statement in an untagged template/);
  });

  // The refusal must not fire on copy. The seed is full of strings that begin with a verb.
  it("does not refuse prose that starts with a verb", () => {
    const census = censusOf(
      "prose.ts",
      'const copy = ["Update your profile", "Create a team", "Drop by the booth", "With love"];',
    );

    expect(census.raw).toBe(0);
  });
});

/**
 * The ratchet, asserted EXACTLY rather than as an upper bound.
 *
 * Exact equality is what forces both halves. A file that gains a raw write exceeds its ceiling and
 * fails; a file whose writes are routed drops below it and ALSO fails, so paying the debt down
 * forces the number down in the same commit instead of quietly leaving headroom for new debt.
 */
describe("the seed routing ratchet", () => {
  for (const obligation of SEED_FILE_OBLIGATIONS) {
    it(`${obligation.file} holds exactly ${obligation.rawCeiling} raw writes`, () => {
      const census = summariseCensus(censusWriteSites(obligation.file));

      expect(census.raw).toBe(obligation.rawCeiling);
    });
  }

  // The declaration is not the population, but it must at least be about real files. A row naming
  // a file that no longer exists is a ceiling nothing is held to.
  it("names only files that exist", () => {
    for (const obligation of SEED_FILE_OBLIGATIONS) {
      expect(() => censusWriteSites(obligation.file)).not.toThrow();
    }
  });

  // The matrix seed must never regain a finance write. The lane is a separate module precisely so
  // this can be asserted on the population rather than trusted to a comment. Asserted against the
  // lane's own table set, not a name prefix: `institution_payment_instructions` is the lane's and
  // does not start with `finance_`, and a prefix would have let it back in unnoticed.
  it("finds no finance write in the matrix seed", () => {
    const census = summariseCensus(censusWriteSites("scripts/seed-test-matrix.ts"));

    expect(census.rawTables.filter((table) => FINANCE_LANE_TABLES.includes(table))).toEqual([]);
  });

  // The lane's table set is derived from the schema, so the one thing left to check is that the
  // derivation reaches everything the lane alone writes. The lane also prices competitions, which
  // the matrix seed writes too; a table both write is the lane's setup, not a finance table.
  it("derives a finance table set that covers every table only the money lane writes", () => {
    const lane = summariseCensus(censusWriteSites("scripts/seed/manual-payment-lane.ts"));
    const matrix = summariseCensus(censusWriteSites("scripts/seed-test-matrix.ts"));
    const laneOnly = lane.rawTables.filter((table) => !matrix.rawTables.includes(table));

    expect(laneOnly.length).toBeGreaterThan(0);

    for (const table of laneOnly) {
      expect(FINANCE_LANE_TABLES).toContain(table);
    }
  });
});
