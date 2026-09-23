/**
 * Which database a seed may write to, answered twice: once from the connection string before a
 * socket is opened, and once by asking the server after one is.
 *
 * Every seed entry point (`scripts/seed-*.ts`) goes through both. The first is cheap and fires
 * before anything is dialled; the second is the one that cannot be lied to. A connection string
 * that says "localhost" is a claim under test: any localhost-terminated tunnel (`ssh -L`,
 * `cloud-sql-proxy`, `kubectl port-forward`, a local PgBouncer, a Docker port publish) satisfies it
 * while the socket lands somewhere else. `current_database()` on that same socket answers with the
 * real name, and the environment layer refuses a process that believes it is production whatever
 * the string says. Neither check may grant permission on its own; both may refuse.
 *
 * The in-band half is the reset's own `assertResetTargetIsDisposable`, imported rather than
 * reimplemented, so the seeds and the reset cannot drift on what "disposable" means.
 */
import type { Sql } from "postgres";
import { loadEnvFile } from "@/server/scripts/env-file";
import { isLocalDatabaseHost, parseDatabaseHost } from "../lib/local-database-host";
import {
  assertResetTargetIsDisposable,
  declaredAppEnvironment,
  presentOrUndefined,
} from "../reset/reset-guard";

/**
 * Loads `.env.local` and refuses, from the connection string alone, anything that is not local.
 *
 * Runs at module scope of each entry point so it fires before a socket is opened. `reason` is the
 * entry point's own account of what it would have written and why that must never reach a
 * database anyone else can reach.
 */
export const resolveSeedDatabaseUrl = (reason: string): string => {
  loadEnvFile({});

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  if (!isLocalDatabaseHost(databaseUrl)) {
    throw new Error(
      `Refusing to seed: DATABASE_URL points at "${parseDatabaseHost(databaseUrl) ?? "<unparseable>"}", ` +
        `which is not a local database.\n${reason}\n` +
        "There is deliberately no override. If a deployed environment genuinely needs fixture " +
        "data, that is a migration or an operator runbook, not this script.",
    );
  }

  return databaseUrl;
};

/**
 * Asks the SERVER which database this connection reaches, and refuses unless every layer permits.
 *
 * Takes the connection and returns nothing the writes need, on purpose: that is the shape whose
 * relocation compiles, so the probe beside it can show the post-state going red when it is moved
 * below the first write. Call it first inside `main()`, before any row is written.
 */
export const assertSeedTargetIsDisposable = (sql: Sql, databaseUrl: string): Promise<void> =>
  assertResetTargetIsDisposable(sql, {
    verb: "reset",
    appEnv: declaredAppEnvironment(),
    databaseUrl,
    redisUrl: presentOrUndefined(process.env.REDIS_URL) ?? null,
  });
