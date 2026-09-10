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
 *   5. rebuilds the Meilisearch competitions index, which nothing else repopulates after a drop
 *   6. flushes Redis, because BullMQ jobs referencing dropped rows are worse than no jobs
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
import { ResetRefused, assertResetTargetIsDisposable, declaredAppEnvironment } from "./reset-guard";

const DRIZZLE_DIR = "drizzle";

const step = (number: number, title: string): void => {
  console.log(`\n[${number}/6] ${title}`);
};

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
 */
const dropEveryMigratedObject = async (sql: postgres.Sql): Promise<void> => {
  await assertEveryObjectIsDroppable(sql);

  await sql.unsafe("drop schema if exists drizzle cascade");

  await sql.unsafe(`
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
    end $$;
  `);

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
 */
const assertEveryObjectIsDroppable = async (sql: postgres.Sql): Promise<void> => {
  const blocked = await sql<{ kind: string; name: string; owner: string }[]>`
    select kind, name, owner
    from (
      select 'table' as kind, c.relname::text as name,
             pg_get_userbyid(c.relowner) as owner, c.relowner as owner_oid
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
      union all
      select 'type', t.typname::text,
             pg_get_userbyid(t.typowner), t.typowner
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typtype = 'e'
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
      `  alter ${item.kind === "type" ? "type" : "table"} public.${item.name} owner to <this role>;`,
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
        "so what follows would not be a database built from zero. Most likely they belong to a " +
        "role other than the one this connected as.",
    );
  }

  console.log("  ✓ no tables, enums, views, routines or migration ledger remain");
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

const rebuildSearchIndex = (): void => {
  if (!process.env.MEILISEARCH_HOST) {
    console.log(
      "  MEILISEARCH_HOST is not set — skipping. Search will return nothing until it is.",
    );
    return;
  }

  execFileSync("npm", ["run", "search:reindex"], { stdio: "inherit" });
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
const flushRedis = async (): Promise<void> => {
  if (!process.env.REDIS_URL) {
    console.log("  REDIS_URL is not set — skipping.");
    return;
  }

  const { default: Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL, {
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
  } finally {
    redis.disconnect();
  }
};

/** Host, port and database name — the part of a connection string that says WHICH database. */
const addressOf = (url: string): string => {
  const parsed = new URL(url);

  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
};

/**
 * The database this drops, resolved EXACTLY as drizzle.config.ts resolves the one it migrates.
 *
 * If these two disagreed the reset would drop one database and migrate another, and the second
 * would look like a successful run.
 *
 * Compared by ADDRESS, never as whole strings. The two URLs are expected to differ: locally they
 * carry `lombakita_migrate` and `lombakita_app`, a DDL-capable role and the app's, which is the
 * arrangement working correctly. A string comparison here would refuse every properly configured
 * machine and be "fixed" by deleting the check.
 */
const resolveResetTarget = (): string => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  const databaseUrl = process.env.DATABASE_URL;
  const target = migrationUrl ?? databaseUrl;

  if (!target) {
    throw new Error("DATABASE_URL or MIGRATION_DATABASE_URL must be set to reset anything");
  }

  // A coherence check, not a safety guard: dropping the migration database while the app reads a
  // different one leaves a reset that reports success over an untouched application database.
  if (migrationUrl && databaseUrl && addressOf(migrationUrl) !== addressOf(databaseUrl)) {
    throw new Error(
      `MIGRATION_DATABASE_URL points at ${addressOf(migrationUrl)} and DATABASE_URL at ` +
        `${addressOf(databaseUrl)}. The reset would drop one and leave the app pointed at the ` +
        "other. Point them at the same database.",
    );
  }

  return target;
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
      redisUrl: process.env.REDIS_URL ?? null,
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

  step(5, "Rebuilding the Meilisearch competitions index");
  rebuildSearchIndex();

  step(6, "Flushing Redis");
  await flushRedis();

  console.log("\nReset complete. The database holds the schema and no rows.\n");
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
