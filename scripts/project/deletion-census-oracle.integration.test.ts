// @vitest-environment node
//
// WHAT A DELETION ACTUALLY DOES, measured against a live Postgres, constraint by constraint.
//
// WHY THIS EXISTS (LAUNCH-D105). The census used to decide whether a foreign key blocks or detaches
// by looking at the SOURCE TABLE's membership in the CASCADE closure. Postgres does not: it applies
// the action per ROW. A table can be inside the closure and still hold a row that survives, and it
// can be inside the closure and hold a row that refuses the whole statement. `platform_ops_notes`
// is both cases in one table — a note ABOUT the deleted user cascades away, and a note the deleted
// operator WROTE blocks the delete outright. No amount of reading the schema module settles which
// of those is true; only the database does.
//
// So this suite stops reading and starts deleting. It enumerates every foreign key from
// `pg_constraint` in the live catalog, plants a row on each edge whose source row nothing else
// removes, deletes a user it created itself, and records what happened as exactly one of
// `refused`, `nulled` or `removed`. Then it asserts the census's two lists equal what it observed.
//
// IT SHARES NO DERIVATION WITH THE CENSUS. The edge list comes from `pg_constraint`, the closure
// this file walks is computed from that catalog read, and the expected side is an OBSERVATION
// rather than a computation. The census is imported for the actual side only, which is the point:
// two independent derivations agreeing is evidence, one derivation checking itself is not.
//
// EVERYTHING ROLLS BACK. The fixture and every probe run inside one transaction that is rolled back
// at the end, and the suite counts every affected table before and after and asserts the counts are
// equal — so a probe that somehow committed is a failing test rather than a dirty dev database.
//
// NOTHING HERE TOUCHES A NON-LOCAL HOST. The connection string is refused unless its host is
// loopback, before a single byte is sent.

import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { isLocalDatabaseHost, parseDatabaseHost } from "../lib/local-database-host";
import {
  ALL_PROBES,
  buildFixture,
  type Fixture,
  type Planted,
  type Probe,
  type Sql,
} from "./census-row-planters";
import {
  blockingForeignKeys,
  cascadeClosure,
  detachingForeignKeys,
  schemaForeignKeys,
} from "./deletion-census";

const DATABASE_URL = TEST_DATABASE_URL;

/** What the database did to the planted row when the subject was deleted. */
type Outcome = "refused" | "nulled" | "removed" | "survived";

/** One foreign key, as the live catalog describes it. */
type CatalogEdge = {
  constraint: string;
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  /** `confdeltype`: `a` NO ACTION, `r` RESTRICT, `c` CASCADE, `n` SET NULL, `d` SET DEFAULT. */
  onDelete: string;
};

/** The catalog's spelling of an edge, used to key probes and to name a missing one. */
const edgeKeyOf = (edge: CatalogEdge): string =>
  `${edge.sourceTable}.${edge.sourceColumns.join("+")}`;

// ---------------------------------------------------------------------------------------------
// Catalog reads. Independent of `deletion-census.ts` by construction.
// ---------------------------------------------------------------------------------------------

const readCatalogEdges = async (sql: Sql): Promise<CatalogEdge[]> => {
  const rows = await sql<
    {
      constraint: string;
      source_table: string;
      source_columns: string[];
      target_table: string;
      target_columns: string[];
      on_delete: string;
    }[]
  >`
    select
      con.conname as constraint,
      src.relname as source_table,
      (select array_agg(att.attname order by k.ord)
         from unnest(con.conkey) with ordinality as k(attnum, ord)
         join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
      ) as source_columns,
      tgt.relname as target_table,
      (select array_agg(att.attname order by k.ord)
         from unnest(con.confkey) with ordinality as k(attnum, ord)
         join pg_attribute att on att.attrelid = con.confrelid and att.attnum = k.attnum
      ) as target_columns,
      con.confdeltype as on_delete
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    where con.contype = 'f'
      and con.connamespace = 'public'::regnamespace
    order by src.relname, con.conname`;

  return rows.map((row) => ({
    constraint: row.constraint,
    sourceTable: row.source_table,
    sourceColumns: row.source_columns,
    targetTable: row.target_table,
    targetColumns: row.target_columns,
    onDelete: row.on_delete,
  }));
};

/** The CASCADE closure from `users`, walked over the catalog's own edges. */
const closureFromCatalog = (edges: readonly CatalogEdge[], from = "users"): Set<string> => {
  const reached = new Set<string>([from]);

  for (let grew = true; grew; ) {
    grew = false;
    for (const edge of edges) {
      if (edge.onDelete !== "c") continue;
      if (!reached.has(edge.targetTable) || reached.has(edge.sourceTable)) continue;
      reached.add(edge.sourceTable);
      grew = true;
    }
  }

  return reached;
};

/** Every base table in `public`, for the before-and-after residue count. */
const publicTables = async (sql: Sql): Promise<string[]> => {
  const rows = await sql<{ table: string }[]>`
    select c.relname as table
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`;

  return rows.map((row) => row.table);
};

const countEveryTable = async (
  sql: Sql,
  tables: readonly string[],
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();

  for (const table of tables) {
    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from ${sql(table)}`;
    counts.set(table, Number(row?.count ?? "0"));
  }

  return counts;
};

const differingTables = (
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): string[] =>
  [...before]
    .filter(([table, count]) => after.get(table) !== count)
    .map(([table, count]) => `${table}: ${count} -> ${after.get(table)}`);

// ---------------------------------------------------------------------------------------------
// Running the probes.
// ---------------------------------------------------------------------------------------------

/** Thrown to force `sql.begin` to roll back; caught immediately after. */
class OracleRollback extends Error {}

const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "23503";

const findPlantedRow = async (
  sql: Sql,
  planted: Planted,
): Promise<Record<string, unknown> | null> => {
  const conditions = Object.entries(planted.identity).map(
    ([column, value]) => sql`${sql(column)} = ${value}`,
  );
  const where = conditions.reduce((left, right) => sql`${left} and ${right}`);

  const rows = await sql`select * from ${sql(planted.table)} where ${where} limit 1`;

  return (rows[0] as Record<string, unknown> | undefined) ?? null;
};

/**
 * What happened to the planted row.
 *
 * `removed` and `nulled` are read off the row's own state, and they are different findings: a
 * removed row is gone, a nulled row is still in the table with its pointer to the deleted user
 * erased. `survived` means the row is still there AND still holds a non-null value in a column
 * constrained by this key — which can only happen if the delete did not actually enforce the
 * constraint, so it is treated as a blocking edge and will disagree with the census loudly.
 */
const observePlantedRow = async (
  sql: Sql,
  planted: Planted,
  constrainedColumns: readonly string[],
): Promise<Outcome> => {
  const row = await findPlantedRow(sql, planted);

  if (row === null) {
    return "removed";
  }

  const stillPointsAtTheDeletedUser = constrainedColumns.some(
    (column) => row[column] !== null && row[column] !== undefined,
  );

  return stillPointsAtTheDeletedUser ? "survived" : "nulled";
};

/**
 * Deletes the subject with one probe's row planted, and reports what happened to that row.
 *
 * Two savepoints, and both are load-bearing. The inner one exists because a 23503 ABORTS the
 * transaction: without rolling back to a marker taken before the delete, every later probe in this
 * run would fail with "current transaction is aborted" rather than with its own result. The outer
 * one discards the probe's own planted row, so probes cannot contaminate each other.
 */
const runProbe = async (
  sql: Sql,
  probeUnderTest: Probe,
  fx: Fixture,
  edgesByKey: ReadonlyMap<string, CatalogEdge>,
): Promise<Map<string, Outcome>> => {
  const constrainedColumns = [
    ...new Set(probeUnderTest.keys.flatMap((key) => edgesByKey.get(key)?.sourceColumns ?? [])),
  ];

  const observed = new Map<string, Outcome>();

  await sql.unsafe("savepoint census_probe");
  try {
    const planted = await probeUnderTest.plant(sql, fx);

    await sql.unsafe("savepoint census_delete");
    try {
      await sql`delete from users where id = ${fx.subject}`;
      await sql.unsafe("release savepoint census_delete");
      observed.set(probeUnderTest.name, await observePlantedRow(sql, planted, constrainedColumns));
    } catch (error) {
      await sql.unsafe("rollback to savepoint census_delete");
      if (!isForeignKeyViolation(error)) {
        throw error;
      }
      observed.set(probeUnderTest.name, "refused");
    }
  } finally {
    await sql.unsafe("rollback to savepoint census_probe");
  }

  const outcome = observed.get(probeUnderTest.name) as Outcome;

  return new Map(probeUnderTest.keys.map((key) => [key, outcome]));
};

type EdgeObservation = {
  key: string;
  constraint: string;
  sourceTable: string;
  sourceColumns: readonly string[];
  targetTable: string;
  targetColumns: readonly string[];
  onDelete: string;
  outcome: Outcome;
  /** True when one planted row is the only evidence for more than one constraint. */
  sharedPlant: boolean;
};

type OracleRun = {
  observations: EdgeObservation[];
  blocking: string[];
  detaching: string[];
  /** Tables whose row count changed across the whole run. Empty means the run left nothing. */
  residue: string[];
};

const runOracle = async (sql: Sql): Promise<OracleRun> => {
  const edges = await readCatalogEdges(sql);
  const closure = closureFromCatalog(edges);
  const population = edges.filter((edge) => closure.has(edge.targetTable));
  const edgesByKey = new Map(population.map((edge) => [edgeKeyOf(edge), edge]));

  const probedKeys = ALL_PROBES.flatMap((entry) => entry.keys);

  const unprobed = population.map(edgeKeyOf).filter((key) => !probedKeys.includes(key));
  if (unprobed.length > 0) {
    throw new Error(
      `no probe plants a row on ${unprobed.length} of the ${population.length} edges, so their ` +
        `outcome would be assumed rather than measured: ${unprobed.join(", ")}`,
    );
  }

  const phantom = probedKeys.filter((key) => !edgesByKey.has(key));
  if (phantom.length > 0) {
    throw new Error(
      `a probe claims an edge the live catalog does not have, so it is planting against a ` +
        `constraint that does not exist: ${phantom.join(", ")}`,
    );
  }

  const tables = await publicTables(sql);
  const before = await countEveryTable(sql, tables);

  const outcomes = new Map<string, Outcome>();

  await sql
    .begin(async (rawTx) => {
      // postgres.js types `TransactionSql` as an `Omit<Sql>`, which drops the call signature even
      // though the value is callable. The cast is the type system's, not the runtime's: this is a
      // real sql function bound to the transaction's connection.
      const tx = rawTx as unknown as Sql;
      const fx = await buildFixture(tx);

      for (const entry of ALL_PROBES) {
        const results = await runProbe(tx, entry, fx, edgesByKey);
        for (const [key, outcome] of results) {
          outcomes.set(key, outcome);
        }
      }

      throw new OracleRollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof OracleRollback)) {
        throw error;
      }
    });

  const after = await countEveryTable(sql, tables);

  const observations = population.map((edge) => {
    const key = edgeKeyOf(edge);

    return {
      key,
      constraint: edge.constraint,
      sourceTable: edge.sourceTable,
      sourceColumns: edge.sourceColumns,
      targetTable: edge.targetTable,
      targetColumns: edge.targetColumns,
      onDelete: edge.onDelete,
      outcome: outcomes.get(key) as Outcome,
      sharedPlant: ALL_PROBES.some((entry) => entry.keys.includes(key) && entry.keys.length > 1),
    };
  });

  for (const observation of observations) {
    if (observation.outcome === undefined) {
      throw new Error(`edge ${observation.key} was enumerated but never observed`);
    }
  }

  return {
    observations,
    // A key blocks a deletion when the delete refuses outright, or when a row is still holding a
    // value in a column this key constrains. The second case is the one the old table-wise rule
    // could not see, and it is why this list is measured rather than derived.
    blocking: observations
      .filter((o) => o.outcome === "refused" || o.outcome === "survived")
      .map((o) => o.key)
      .sort(),
    detaching: observations
      .filter((o) => o.outcome === "nulled")
      .map((o) => o.key)
      .sort(),
    residue: differingTables(before, after),
  };
};

const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;

afterAll(async () => {
  await client?.end();
});

let oracleRun: Promise<OracleRun> | null = null;

/**
 * The oracle's result, computed once for the whole file.
 *
 * It runs the entire deletion sequence inside one transaction, so every test in this suite reads
 * one measurement rather than re-running the deletes — and the transaction is rolled back by the
 * run itself, which is what makes the residue count meaningful.
 */
const oracle = (): Promise<OracleRun> => {
  if (oracleRun === null) {
    if (!DATABASE_URL) {
      throw new Error("the deletion oracle needs a database; this suite should have skipped");
    }
    if (!isLocalDatabaseHost(DATABASE_URL)) {
      throw new Error(
        `refusing to run the deletion oracle against ${parseDatabaseHost(DATABASE_URL) ?? "an unparseable host"}: ` +
          "it deletes users, and it may only do that on a loopback database",
      );
    }
    oracleRun = runOracle(client as unknown as Sql);
  }

  return oracleRun;
};

// ---------------------------------------------------------------------------------------------
// The assertions.
// ---------------------------------------------------------------------------------------------

const censusKey = (key: { sourceTable: string; sourceColumns: readonly string[] }): string =>
  `${key.sourceTable}.${key.sourceColumns.join("+")}`;

const censusBlocking = blockingForeignKeys().map(censusKey).sort();
const censusDetaching = detachingForeignKeys().map(censusKey).sort();

describe.skipIf(skipWithoutDatabase)("the deletion census oracle", () => {
  it("exercises every foreign key the closure reaches, and leaves no edge unmeasured", async () => {
    const run = await oracle();

    // A floor derived from the census rather than invented: set equality below would pass on two
    // empty lists, so the run has to be shown to have covered at least what the census claims.
    expect(run.observations.length).toBeGreaterThanOrEqual(
      censusBlocking.length + censusDetaching.length,
    );

    for (const observation of run.observations) {
      expect(observation.outcome, `${observation.key} has no observed outcome`).toBeDefined();
    }
  });

  it("leaves nothing behind: every table holds the same rows after the run as before it", async () => {
    const run = await oracle();

    expect(run.residue).toEqual([]);
  });

  it("never observes a row surviving the delete still pointing at the deleted user", async () => {
    const run = await oracle();

    expect(run.observations.filter((o) => o.outcome === "survived").map((o) => o.key)).toEqual([]);
  });

  it("agrees with the census on which keys block a deletion", async () => {
    const run = await oracle();

    expect(run.blocking).toEqual(censusBlocking);
  });

  it("agrees with the census on which keys detach instead of blocking", async () => {
    const run = await oracle();

    expect(run.detaching).toEqual(censusDetaching);
  });

  it("names every edge the table-wise rule got wrong", async () => {
    const run = await oracle();
    const closure = new Set(cascadeClosure("users"));
    const outcomeOf = (key: string) => run.observations.find((o) => o.key === key)?.outcome;

    // THE BLIND SPOT, derived from the schema rather than listed: the rule asked whether the SOURCE
    // TABLE was inside the closure, so it dropped every blocking or detaching edge whose source
    // table is — without asking what that edge's rows do.
    const insideTheClosure = schemaForeignKeys()
      .filter((key) => ["no action", "restrict", "set null"].includes(key.onDelete))
      .filter((key) => closure.has(key.sourceTable))
      .map(censusKey)
      .sort();

    // The database's answer to the same question. Every edge in the blind spot refuses the statement
    // or nulls its pointer: none is taken by the cascade, which is what made the rule wrong about
    // all of them rather than about a subset of them.
    const measured = run.observations
      .filter((o) => closure.has(o.sourceTable))
      .filter((o) => o.outcome === "refused" || o.outcome === "nulled")
      .map((o) => o.key)
      .sort();

    expect(measured).toEqual(insideTheClosure);
    expect(measured.length).toBeGreaterThan(0);

    // And the census has to put each of them where the database did. A note the deleted operator
    // WROTE is not a note about them, so `platform_ops_notes.created_by_id` refuses the statement —
    // the rule read that table as one whose rows cannot outlive the deletion, which is true of its
    // other edge and false here. The rest are SET NULL pointers whose source tables reach the
    // closure anyway — through a team, a registration or a profile — so the rule returned those
    // tables as removed and never looked at the edge. THIS is the half that fails if the rule goes
    // back to reading the table: it reports none of them.
    expect(censusBlocking.filter((key) => insideTheClosure.includes(key))).toEqual(
      measured.filter((key) => outcomeOf(key) === "refused"),
    );
    expect(censusDetaching.filter((key) => insideTheClosure.includes(key))).toEqual(
      measured.filter((key) => outcomeOf(key) === "nulled"),
    );
  });

  it("reports the one pair of edges a single planted row is evidence for", async () => {
    const run = await oracle();
    const shared = run.observations
      .filter((o) => o.sharedPlant)
      .map((o) => o.constraint)
      .sort();

    // `team_id` and `(competition_id, team_id)` both reference the same team row, both CASCADE, and
    // both fire on that row's removal, so no planting can tell them apart. Both are reported; this
    // says out loud that the second confirmation is not independent.
    expect(shared).toEqual([
      "competition_registrations_competition_team_fk",
      "competition_registrations_team_id_teams_id_fk",
    ]);
  });

  it("observes every edge the closure reaches, and no edge outside it", async () => {
    const run = await oracle();

    // What the title now claims is what this comparison checks: the run's edges against the
    // catalog's, read from the catalog rather than from the run, in both directions. The PRINTING
    // below is conditional and nothing asserts it — a test that returns before asserting anything
    // has asserted nothing and still counts as a pass (LAUNCH-D167), which is why the assertion
    // sits here rather than under the flag.
    const edges = await readCatalogEdges(client as unknown as Sql);
    const reached = new Set(closureFromCatalog(edges));
    const inTheClosure = edges
      .filter((edge) => reached.has(edge.targetTable))
      .map(edgeKeyOf)
      .sort();

    expect(run.observations.map((o) => o.key).sort()).toEqual(inTheClosure);

    if (process.env.CENSUS_ORACLE_TABLE !== "1") {
      return;
    }

    const rows = run.observations.map(
      (o) =>
        `${o.constraint} | ${o.sourceTable}.${o.sourceColumns.join("+")} -> ` +
        `${o.targetTable}.${o.targetColumns.join("+")} | ON DELETE ${o.onDelete} | ${o.outcome}`,
    );

    console.log(`\n${run.observations.length} edges\n${rows.join("\n")}\n`);
  });
});
