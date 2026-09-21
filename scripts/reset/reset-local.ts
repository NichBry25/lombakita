/**
 * Takes local infrastructure from populated to freshly migrated, in one command.
 *
 *   npm run db:reset
 *
 * Step 7.7's Stage 9 rule binds the automated suites to a freshly reset database, and no reset path
 * existed — so the rule could not be met by anything except deleting rows by hand and hoping the
 * list was complete. This is that path.
 *
 * WHAT IT DOES, in order, refusing before any of it if the target is not disposable:
 *   1. asserts the target is disposable, asking the SERVER which database it is (reset-guard.ts)
 *   2. drops the public and drizzle schemas, so the migration ledger goes with the tables
 *   3. applies every migration from zero through `db:migrate:guarded`
 *   4. verifies the rebuilt ledger against the journal, including LAUNCH-D29's two pinned indices
 *   5. seeds the testing matrix, so what comes out is a usable environment rather than bare schema
 *   6. rebuilds the Meilisearch competitions index, which nothing else repopulates after a drop
 *   7. flushes Redis, because BullMQ jobs referencing dropped rows are worse than no jobs
 *
 * THE SEED SITS BETWEEN THE LEDGER CHECK AND THE REINDEX, and the position is the point rather than
 * an ordering preference. Before it existed this path ended at step 4 with an empty database, and
 * the reindex that followed rebuilt an index from zero rows and asserted 0 == 0, an instrument
 * that could not fail, over a database nobody could use. Seeding after the reindex would leave the
 * same vacuous assertion with populated tables behind it, which is worse: it would look measured.
 *
 * THERE IS NO PRODUCTION MODE AND NO OVERRIDE FLAG. Not as a matter of policy but of construction:
 * nothing here accepts a "yes I am sure" value, so there is no argument anyone can pass to make it
 * run against a protected database. `db:migrate:guarded`'s CONFIRM_PROD_MIGRATION escape hatch is
 * deliberately not mirrored — a migration is additive and a drop is not.
 */

import { execFileSync } from "node:child_process";

import postgres from "postgres";

import { loadEnvFile, describeEnvFileLoad } from "@/server/scripts/env-file";
import { readJournalMigrations, compareAppliedToJournal } from "@/server/db/schema-drift";
import type { AppliedMigration } from "@/server/db/schema-drift";
import { ACCEPTED_DIVERGENCES } from "@/server/db/schema-drift";
import {
  ResetRefused,
  assertResetTargetIsDisposable,
  declaredAppEnvironment,
  presentOrUndefined,
  resolveResetTarget,
} from "./reset-guard";

const DRIZZLE_DIR = "drizzle";

/**
 * How long the drop waits for a lock before giving up.
 *
 * Without it the drop waits forever with no output. Anything holding a read lock on a table stops
 * it dead: a dev-server request in flight, an open Drizzle Studio tab, a `psql` left mid
 * transaction. The operator sees a command that has printed step 2 and then nothing, and the usual
 * response is to interrupt it, which is the one input that used to leave the database wrecked.
 * Failing in ten seconds with Postgres naming the lock is strictly better than waiting silently.
 */
const DROP_LOCK_TIMEOUT = "10s";

const TOTAL_STEPS = 7;

const step = (number: number, title: string): void => {
  console.log(`\n[${number}/${TOTAL_STEPS}] ${title}`);
};

/**
 * An unset OR EMPTY variable is absent, not a value.
 *
 * `process.env.REDIS_URL ?? null` yields `""` for a variable that is set to nothing, and `""` is
 * not a URL — the host layer could not parse it and refused the whole reset for a Redis that was
 * never configured. Found by the probe suite rather than by reading: two probes run the reset with
 * Redis deliberately blanked, and both stopped at a refusal that had nothing to do with what they
 * were measuring.
 */
const optionalUrl = (value: string | undefined): string | null => presentOrUndefined(value) ?? null;

/**
 * Drops everything the migrations create, including the ledger that records they ran.
 *
 * OBJECT BY OBJECT, NOT `DROP SCHEMA public`. The reset connects as the migration role, and that
 * role owns every table and type it created but does NOT own the schema itself — `DROP SCHEMA
 * public` fails 42501 "must be owner of schema public". It failed exactly that way the first time
 * this ran, AFTER the drizzle schema had already gone, which is the state that looks like a
 * successful reset and is not one. Dropping the objects needs only ownership of the objects.
 *
 * NOT `DROP DATABASE` either. A database cannot be dropped from a connection to itself, so dropping
 * one means connecting to a DIFFERENT database and naming this one — at which point the identity
 * assertion would be running against a connection that is not the one doing the damage, which is
 * the exact property this path exists to have.
 *
 * `drizzle` holds `__drizzle_migrations`. Leaving it behind is the failure that looks like success:
 * the tables are gone, drizzle reads a full ledger, applies nothing, and the reset produces an
 * empty database that reports itself fully migrated.
 *
 * pgcrypto is deliberately left installed. Migration 0002 creates it `IF NOT EXISTS`, so a database
 * that still has it and one that never did converge on the same schema.
 *
 * ONE TRANSACTION AROUND BOTH STATEMENTS, and the boundary is the point rather than an
 * optimisation. The ledger and the objects it describes must go together or not at all. Dropping
 * the drizzle schema on its own connection and the objects in a separate atomic block left a
 * database that still held all 53 tables while claiming, by the absence of a ledger, to hold none.
 * `db:migrate:guarded` cannot recover from that state: it recreates an empty ledger, replays
 * migration 0000 into tables that already exist, and fails. Only another reset gets out of it.
 *
 * Making the transaction explicit rather than relying on the `DO` block's own atomicity also means
 * a seventh statement added in this region is inside the boundary by default instead of silently
 * outside it.
 */
const dropEveryMigratedObject = async (sql: postgres.Sql): Promise<void> => {
  await assertEveryObjectIsDroppable(sql);

  await sql.begin(async (tx) => {
    await tx.unsafe(`set local lock_timeout = '${DROP_LOCK_TIMEOUT}'`);

    await tx.unsafe("drop schema if exists drizzle cascade");

    await tx.unsafe(`
      do $$
      declare item record;
      begin
        for item in select tablename from pg_tables where schemaname = 'public' loop
          execute format('drop table if exists public.%I cascade', item.tablename);
        end loop;

        for item in
          select t.typname
          from pg_type t
          join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public' and t.typtype = 'e'
        loop
          execute format('drop type if exists public.%I cascade', item.typname);
        end loop;

        -- Routines LAST, because a trigger belongs to its table: the table loop above has already
        -- taken the trigger, so the function it called has no dependent left by the time this runs.
        -- The predicate is the one assertPublicSchemaIsEmpty counts this class with, deliberately
        -- the same query rather than a matching one — migration 0061 creates the first standalone
        -- routine in the history, and while this loop dropped nothing here the check below counted
        -- the survivor and refused the reset.
        for item in
          select p.proname, pg_get_function_identity_arguments(p.oid) as args
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
          where n.nspname = 'public' and d.objid is null
        loop
          execute format('drop function if exists public.%I(%s) cascade', item.proname, item.args);
        end loop;
      end $$;
    `);
  });

  await assertPublicSchemaIsEmpty(sql);
};

/**
 * Refuses BEFORE dropping anything if some object could not be dropped anyway.
 *
 * A drop the connecting role has no right to make fails 42501 partway through, and the message
 * Postgres returns names one object with no indication that fifty others already went. It happened
 * here: three enums on this machine are owned by `postgres` rather than by the migration role,
 * left behind by some earlier manual repair, and the run died on the first of them.
 *
 * Checked in one query up front so the answer is "this run will not work, and here is every reason"
 * rather than a partial reset and a raw error. `pg_has_role(... 'USAGE')` is the right predicate
 * rather than an owner-name comparison: a role that is a MEMBER of the owning role may drop the
 * object too, and so may a superuser, which is the arrangement CI runs under.
 *
 * It covers the same three classes `dropEveryMigratedObject` drops — tables, enum types, and
 * non-extension routines — because a check that inspects fewer classes than the loop removes is
 * how the reset lane broke once already: the survivor assertion counted routines while the loop
 * dropped none, and the run failed after the drop had committed.
 */
/** The keyword `ALTER <kind> … OWNER TO` needs, per class this file drops. */
const ALTER_OWNER_KEYWORD: Record<"table" | "type" | "routine", string> = {
  table: "table",
  type: "type",
  routine: "function",
};

const assertEveryObjectIsDroppable = async (sql: postgres.Sql): Promise<void> => {
  const blocked = await sql<
    { kind: "table" | "type" | "routine"; name: string; owner: string; args: string }[]
  >`
    select kind, name, owner, args
    from (
      select 'table' as kind, c.relname::text as name,
             pg_get_userbyid(c.relowner) as owner, c.relowner as owner_oid, '' as args
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
      union all
      select 'type', t.typname::text,
             pg_get_userbyid(t.typowner), t.typowner, ''
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typtype = 'e'
      union all
      select 'routine', p.proname::text,
             pg_get_userbyid(p.proowner), p.proowner,
             pg_get_function_identity_arguments(p.oid)
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
        where n.nspname = 'public' and d.objid is null
    ) owned
    where not pg_has_role(current_user, owned.owner_oid, 'USAGE')
    order by kind, name
  `;

  if (blocked.length === 0) {
    return;
  }

  const listed = blocked.map((item) => `${item.kind} ${item.name} (owner ${item.owner})`);
  const repairs = blocked.map(
    (item) =>
      `  alter ${ALTER_OWNER_KEYWORD[item.kind]} public.${item.name}` +
      `${item.args === "" ? "" : `(${item.args})`} owner to <this role>;`,
  );

  throw new Error(
    `${blocked.length} object(s) in public belong to a role this connection cannot drop through, ` +
      `so the reset would fail partway and leave a half-dropped database:\n  ${listed.join("\n  ")}\n\n` +
      `Reassign them as a superuser, then run the reset again:\n${repairs.join("\n")}`,
  );
};

/**
 * Confirms nothing the migrations own survived the drop.
 *
 * Rule 18: the end state is checked rather than inferred from the absence of an error. An object
 * this role could not drop — one left behind by a different owner — would otherwise be re-created
 * over by the migration run and produce a database that is not the one from zero it reports being.
 *
 * Extension-owned routines are excluded because pgcrypto is intentionally left in place; a routine
 * belonging to no extension is not, and is named here rather than tolerated.
 *
 * WHAT IT DOES NOT INSPECT, said out loud in the success line rather than left to be inferred.
 * Materialized views, standalone sequences, domains, composite types and non-`public` schemas are
 * outside all five queries, and `pg_tables`/`pg_views` both exclude `relkind='m'`, so a matview is
 * invisible to the drop loop AND to this check. None are reachable from the migrations in this
 * checkout, which is why the coverage gap is tolerable; certifying the schema "empty" on the
 * strength of five classes is not, because that is an instrument reporting a result it did not
 * measure. The message therefore claims exactly the classes it looked at and names the rest.
 */
const assertPublicSchemaIsEmpty = async (sql: postgres.Sql): Promise<void> => {
  const rows = await sql<{ kind: string; count: string }[]>`
    select 'table' as kind, count(*)::text as count
      from pg_tables where schemaname = 'public'
    union all
    select 'enum', count(*)::text
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype = 'e'
    union all
    select 'view', count(*)::text from pg_views where schemaname = 'public'
    union all
    select 'routine', count(*)::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
      where n.nspname = 'public' and d.objid is null
    union all
    select 'migration-ledger', count(*)::text
      from pg_namespace where nspname = 'drizzle'
  `;

  const survivors = rows.filter((row) => Number(row.count) > 0);

  if (survivors.length > 0) {
    throw new Error(
      `the drop left objects behind (${survivors.map((s) => `${s.count} ${s.kind}`).join(", ")}), ` +
        "so what follows would not be a database built from zero. Ownership is not the likely cause " +
        "and is not what this means: assertEveryObjectIsDroppable refuses up front if any object " +
        "belongs to a role this connection cannot drop through, so nothing here was dropped and " +
        "failed. A survivor means dropEveryMigratedObject and this check no longer cover the same " +
        "classes — the migrations created a class of object the drop loop does not remove. Add that " +
        "class to the loop; do not relax this assertion.",
    );
  }

  console.log(
    "  ✓ no tables, enums, views, non-extension routines or migration ledger remain in public " +
      "(not inspected: materialized views, sequences, domains, composite types, other schemas)",
  );
};

const applyMigrationsFromZero = (): void => {
  // Through the guarded entry point (Rule 13), never `drizzle-kit migrate` directly.
  execFileSync("npm", ["run", "db:migrate:guarded"], { stdio: "inherit" });
};

/**
 * Confirms the rebuilt ledger is the one this checkout declares, per row.
 *
 * ALSO CHECKS LAUNCH-D29'S TWO PINNED INDICES EXPLICITLY. `compareAppliedToJournal` already accepts
 * either permitted hash at 32 and 47, so it stays silent whichever one is present — which means a
 * reset could silently start producing the legacy hash and the comparison would never say so. A
 * from-zero database must hold the CURRENT file's hash at both, and that is a different claim from
 * "no drift", so it is asserted separately.
 */
const verifyLedgerRebuiltFromZero = async (sql: postgres.Sql): Promise<void> => {
  const journal = readJournalMigrations(DRIZZLE_DIR);
  const rows = await sql<{ hash: string; created_at: string }[]>`
    select hash, created_at
    from drizzle.__drizzle_migrations
    order by created_at asc, id asc
  `;

  const applied: AppliedMigration[] = rows.map((row) => ({
    hash: row.hash,
    createdAtMillis: Number(row.created_at),
  }));

  const problems = compareAppliedToJournal(journal, applied);

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(
        `  drift at index ${problem.index} (${problem.tag ?? "?"}): ${problem.problem}`,
      );
    }
    throw new Error(
      `the rebuilt database does not match the ${journal.length} migrations this checkout declares`,
    );
  }

  for (const divergence of ACCEPTED_DIVERGENCES) {
    const declared = journal.find((entry) => entry.index === divergence.index);
    const found = applied[divergence.index];

    if (!declared || !found) {
      throw new Error(
        `pinned index ${divergence.index} (${divergence.tag}) is absent from the rebuilt ledger`,
      );
    }

    if (found.hash !== declared.hash) {
      throw new Error(
        `pinned index ${divergence.index} (${divergence.tag}) holds ${found.hash.slice(0, 12)}…, ` +
          `but a database built from zero must hold this checkout's ${declared.hash.slice(0, 12)}…. ` +
          `Holding the legacy hash instead would mean the reset did not rebuild from zero.`,
      );
    }

    console.log(
      `  ✓ index ${divergence.index} (${divergence.tag}) holds this checkout's hash, ` +
        `not the legacy one — LAUNCH-D29's relaxation still has two distinct sides`,
    );
  }

  console.log(`  ✓ all ${journal.length} migrations applied, matching row for row by hash`);
};

/**
 * Fills the freshly migrated database with the testing matrix.
 *
 * NOT OPTIONAL AND NOT SKIPPABLE, unlike steps 6 and 7. Those two reach infrastructure a developer
 * may legitimately not be running; this one needs nothing but the database the previous four steps
 * just rebuilt. A reset that silently produced bare schema is the state this whole step exists to
 * end, so there is no configuration under which it is allowed to quietly not happen.
 *
 * Shelled out rather than imported for the same reason `applyMigrationsFromZero` is: the seed reads
 * its own environment, opens its own connection and enforces its own refusals at module scope, and
 * importing it would run all of that inside a process that has already resolved a different target.
 */
const seedTestingMatrix = (): void => {
  execFileSync("npm", ["run", "db:seed"], { stdio: "inherit" });
};

/** Returns why the step did not run, or null when it did. */
const rebuildSearchIndex = (): string | null => {
  if (!optionalUrl(process.env.MEILISEARCH_HOST)) {
    const reason = "MEILISEARCH_HOST is not set, so search will return nothing until it is";
    console.log(`  skipped: ${reason}.`);

    return reason;
  }

  // `--expect-populated` because step 5 has just seeded. Without it the reindex would rebuild
  // whatever it found and assert its count against itself, which is true for zero as readily as for
  // any other number; the assertion that gives this step its meaning only has meaning once the
  // caller has told it a number it must not be.
  execFileSync("npm", ["run", "search:reindex", "--", "--expect-populated"], { stdio: "inherit" });

  return null;
};

/**
 * Empties Redis.
 *
 * DESTRUCTIVE IN ITS OWN RIGHT, which is why it sits behind the same refusal as the drop rather
 * than a weaker one: BullMQ's queues live here, so this discards in-flight and delayed jobs. After
 * a database reset that is the correct outcome — every one of those jobs names a row that no longer
 * exists — but it is a deletion, not a cache eviction, and holding no rows does not make it one.
 *
 * FLUSHDB, not FLUSHALL: this empties the logical database the app uses and leaves any other on the
 * same server alone.
 */
const flushRedis = async (): Promise<string | null> => {
  const url = optionalUrl(process.env.REDIS_URL);

  if (!url) {
    const reason = "REDIS_URL is not set, so any queued BullMQ jobs are untouched";
    console.log(`  skipped: ${reason}.`);

    return reason;
  }

  const { default: Redis } = await import("ioredis");
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  });

  try {
    await redis.connect();
    const before = await redis.dbsize();
    await redis.flushdb();
    console.log(`  ✓ flushed ${before} key(s), including any queued BullMQ jobs`);

    return null;
  } finally {
    redis.disconnect();
  }
};

/**
 * Says what the run actually did, naming any step that did not run and why.
 *
 * A skip is legitimate here: a developer without Meilisearch or Redis should still get a working
 * database out of this. A SILENT skip is not. An unqualified "Reset complete." over a run that
 * rebuilt no search index reports a state the operator does not have, which is the same defect as
 * an instrument reporting a result it did not measure.
 */
const reportOutcome = (steps: readonly { step: number; reason: string | null }[]): void => {
  const skipped = steps.filter(
    (entry): entry is { step: number; reason: string } => entry.reason !== null,
  );

  if (skipped.length === 0) {
    console.log("\nReset complete. The database holds the schema and the seeded testing matrix.\n");
    return;
  }

  const listed = skipped.map((entry) => `  step ${entry.step} skipped: ${entry.reason}`);

  console.log(
    `\nDatabase reset complete: it holds the schema and the seeded testing matrix. ` +
      `${skipped.length} of ${TOTAL_STEPS} steps did NOT run, so the rest of your local stack is ` +
      `not reset:\n${listed.join("\n")}\n`,
  );
};

const main = async (): Promise<void> => {
  console.log(describeEnvFileLoad(loadEnvFile({})));

  // Read BEFORE anything else runs. `scripts/lib/live-harness.ts` assigns APP_ENV="test" at module
  // scope, so a reset that imported it would resolve to a permitted environment no matter what the
  // operator set, and the environment layer would be a guard that cannot fail. This path therefore
  // does not build on that harness, and reads the value itself.
  const appEnv = declaredAppEnvironment();
  const target = resolveResetTarget();

  const sql = postgres(target, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 15 });

  try {
    step(1, "Checking the target is disposable");
    await assertResetTargetIsDisposable(sql, {
      appEnv,
      databaseUrl: target,
      redisUrl: optionalUrl(process.env.REDIS_URL),
    });

    step(2, "Dropping every migrated object");
    await dropEveryMigratedObject(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }

  step(3, "Applying every migration from zero");
  applyMigrationsFromZero();

  const verifier = postgres(target, { max: 1, prepare: false, idle_timeout: 5 });
  try {
    step(4, "Verifying the rebuilt ledger");
    await verifyLedgerRebuiltFromZero(verifier);
  } finally {
    await verifier.end({ timeout: 5 });
  }

  step(5, "Seeding the testing matrix");
  seedTestingMatrix();

  step(6, "Rebuilding the Meilisearch competitions index");
  const searchSkipped = rebuildSearchIndex();

  step(7, "Flushing Redis");
  const redisSkipped = await flushRedis();

  reportOutcome([
    { step: 6, reason: searchSkipped },
    { step: 7, reason: redisSkipped },
  ]);
};

main().catch((error: unknown) => {
  // A refusal is an operational message written for whoever ran the command; a stack trace buries
  // it. Anything else is a genuine fault and keeps its stack.
  if (error instanceof ResetRefused) {
    console.error(`\nREFUSED [${error.layer}]\n${error.message}\n`);
  } else {
    console.error("\nReset failed:", error);
  }

  process.exitCode = 1;
});
