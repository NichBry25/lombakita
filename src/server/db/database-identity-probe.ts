/**
 * Whether DATABASE_URL reaches the database, and the role, its environment is supposed to serve from.
 *
 * THE RUNTIME HALF OF A PAIR. `migration-database-probe.ts` asks this of the credential that
 * MIGRATES; this asks it of the credential the app SERVES with. The fault both exist for is the same
 * one (DEC-0207) — a connection string whose own name and user are the claim under test, agreed with
 * by every layer that never asked the server — and nothing about it is specific to the migration
 * role: Railway production's migration credential named and hosted staging while every check in the
 * repository was content.
 *
 * THE EXPECTATION IS DECLARED, NOT OBSERVED. It comes from the environment the CALLER named on its
 * command line, never from APP_ENV and never out of the connection string, so the two sides of the
 * comparison have independent origins. A caller that has not declared an environment has no
 * expectation to assert against and must not call this.
 *
 * Its own client, built from DATABASE_URL by `createSqlClient` (`server/db/client.ts`), closed in a
 * `finally`. Its own rather than the app's pooled client, which is shared with request handling: a
 * probe that closed that one would take the process's database away with it.
 */

import { CANONICAL_DATABASE_NAME, CANONICAL_DATABASE_ROLE } from "@/config/env-shape";
import type { DeployEnvironment } from "@/config/env-shape";
import { createSqlClient } from "@/server/db/client";
import { identityMismatch, readServerIdentity } from "@/server/scripts/database-identity";
import type { IdentifiableConnection } from "../../../scripts/reset/reset-guard";

/**
 * Refuses unless the server answers as the declared environment's database, in its RUNTIME role.
 *
 * Both fields, and separately: a lane that reached the right database as the wrong role has a
 * credential that can do a different set of things there than this lane assumes, which is exactly
 * what the database-name comparison alone cannot see.
 *
 * Takes the connection rather than opening one — `IdentifiableConnection`, the structural shape
 * `reset-guard.ts` exports — so the comparison is exercisable without a database. The refusal message
 * is `identityMismatch`'s own, so a reader of a failed deploy gate is told which field was wrong and
 * both values.
 */
export const assertDatabaseIdentity = async (
  sql: IdentifiableConnection,
  environment: DeployEnvironment,
): Promise<void> => {
  const observed = await readServerIdentity(sql);
  const mismatch = identityMismatch(observed, {
    database: CANONICAL_DATABASE_NAME[environment],
    role: CANONICAL_DATABASE_ROLE[environment].runtime,
  });

  if (mismatch !== null) {
    throw new Error(mismatch);
  }
};

/**
 * The same assertion over a real connection, for a run that has declared its environment.
 *
 * A connection or query failure propagates as its own error and is reported as such. Nothing here
 * formats the URL into a message, so no credential reaches a log through this path.
 */
export const probeDatabaseIdentity = async (environment: DeployEnvironment): Promise<void> => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not configured");
  }

  const sql = createSqlClient(url);

  try {
    await assertDatabaseIdentity(sql, environment);
  } finally {
    await sql.end({ timeout: 5 });
  }
};
