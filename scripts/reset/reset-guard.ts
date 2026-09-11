/**
 * Whether the infrastructure in front of this process may be destroyed.
 *
 * The reset path drops every table and flushes every Redis key. There is no application path that
 * undoes either, and the two databases this must never reach hold the platform's only real accounts.
 * So the question is not "did the operator mean this" — it is "which database is actually on the end
 * of this socket", and those are different questions with different answers.
 *
 * THREE LAYERS, AND THEY ARE NOT EQUALLY GOOD. Stated in order of how much they are worth:
 *
 *   1. DATABASE IDENTITY, IN BAND (`current_database()`), asked of the same connection that will
 *      run the DROP. This is the authoritative one. A connection string's own path segment is the
 *      claim under test rather than the evidence: Railway production carried a
 *      `MIGRATION_DATABASE_URL` whose host and name both said staging, and every check in the
 *      repository agreed with it because none of them asked the server (DEC-0207, LAUNCH-D24).
 *   2. ENVIRONMENT, from configuration. Catches the case layer 1 cannot see — a disposable database
 *      name reached from a process that believes it is production.
 *   3. CONNECTION HOST, from configuration, and the weakest of the three. LAUNCH-D23 is exactly
 *      this check issuing an affirmatively reassuring verdict about a leaked credential, so it is
 *      here as an additional refusal and never as the safety argument.
 *
 * Layers 2 and 3 read configuration and can therefore be lied to. Layer 1 cannot, which is why the
 * other two may only ever ADD a refusal and none of them may grant permission on its own.
 */

import { CANONICAL_DATABASE_NAME } from "@/config/env-shape";
import { resolveAppEnvironment, type AppEnvironment } from "@/config/env";
import { isLoopbackUrl, parseDatabaseHost } from "../lib/local-database-host";

/**
 * Databases that must never be reset, named rather than inferred.
 *
 * Sourced from the deploy gate's own table so the two cannot drift: an environment added there is
 * protected here without anyone remembering to do it twice.
 */
export const PROTECTED_DATABASE_NAMES: readonly string[] = Object.freeze(
  Object.values(CANONICAL_DATABASE_NAME),
);

/**
 * Environments whose data is disposable by definition.
 *
 * AN ALLOW-LIST, NOT A DENY-LIST. `resolveAppEnvironment` falls back to "local" when nothing is
 * set, so a deny-list would have to enumerate every way of being production and would wave through
 * whatever it had not thought of. This refuses `preview`, `staging` and `production`, and refuses
 * any future environment name by not mentioning it.
 */
const DISPOSABLE_ENVIRONMENTS: readonly AppEnvironment[] = Object.freeze(["local", "test"]);

export type ResetRefusal = {
  /** Which layer refused, so a probe can assert it went red for the reason it claims. */
  layer: "database-identity" | "environment" | "connection-host";
  message: string;
};

/**
 * Refuses a database this must never reach, by the name the SERVER reported.
 *
 * Takes the name rather than a connection string on purpose: passing a URL here would make it
 * possible to call this with the string instead of the server's answer, which is the whole defect
 * it exists to prevent.
 */
export const findDatabaseNameRefusal = (databaseName: string): ResetRefusal | null => {
  if (!PROTECTED_DATABASE_NAMES.includes(databaseName)) {
    return null;
  }

  return {
    layer: "database-identity",
    message:
      `refusing to reset: the server on this connection reports current_database() = ` +
      `"${databaseName}", which is a protected database (${PROTECTED_DATABASE_NAMES.join(", ")}). ` +
      "This is the database's own answer, not the connection string's, so there is no value to " +
      "correct here other than where this process is pointed.",
  };
};

export const findEnvironmentRefusal = (appEnv: AppEnvironment): ResetRefusal | null => {
  if (DISPOSABLE_ENVIRONMENTS.includes(appEnv)) {
    return null;
  }

  return {
    layer: "environment",
    message:
      `refusing to reset: APP_ENV resolves to "${appEnv}", and the reset path runs only in ` +
      `${DISPOSABLE_ENVIRONMENTS.join(" or ")}. There is deliberately no override flag: a reset ` +
      "that can be authorised is a reset that will eventually be authorised by mistake.",
  };
};

export const findConnectionHostRefusal = (url: string, variable: string): ResetRefusal | null => {
  if (isLoopbackUrl(url)) {
    return null;
  }

  return {
    layer: "connection-host",
    message:
      `refusing to reset: ${variable} points at "${parseDatabaseHost(url) ?? "<unparseable>"}", ` +
      "which is not loopback. This is the weakest of the three checks — it reads configuration " +
      "rather than asking the server — and it is here to add a refusal, never to grant one.",
  };
};

/** Thrown rather than exiting, so a caller's `finally` still closes its connections (Rule 35). */
export class ResetRefused extends Error {
  readonly layer: ResetRefusal["layer"];

  constructor(refusal: ResetRefusal) {
    super(refusal.message);
    this.name = "ResetRefused";
    this.layer = refusal.layer;
  }
}

/**
 * An unset OR EMPTY environment variable is ABSENT, not a value.
 *
 * `??` treats `""` as present, so a variable set to nothing SHADOWS the fallback behind it instead
 * of deferring to it. Every consumer of an optional variable in this path goes through here.
 */
export const presentOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
};

/**
 * The environment this process resolves to, read from configuration before anything mutates it.
 *
 * Both variables go through `presentOrUndefined` rather than `??`. With `??`, an APP_ENV set to the
 * empty string shadowed a correctly set NEXT_PUBLIC_APP_ENV, `resolveAppEnvironment` then fell
 * through to its own "local" default, and the environment layer PERMITTED a reset in a process
 * whose only environment declaration said production.
 */
export const declaredAppEnvironment = (): AppEnvironment =>
  resolveAppEnvironment(
    presentOrUndefined(process.env.APP_ENV) ?? presentOrUndefined(process.env.NEXT_PUBLIC_APP_ENV),
  );

/**
 * A connection that can answer `current_database()`.
 *
 * Structurally typed rather than importing postgres.js's `Sql`, so the assertion can be exercised
 * against a stub in a unit test without a database, and against the real client in the reset path.
 */
export type IdentifiableConnection = {
  unsafe: (query: string) => Promise<readonly Record<string, unknown>[]>;
};

/**
 * Refuses unless every layer permits, asking the SERVER for the database's identity.
 *
 * DELIBERATELY TAKES AND RETURNS NOTHING THE DESTRUCTIVE WORK NEEDS. Rule 36 prefers the shape
 * where a guard's return value is the input the protected operation requires, because then a
 * reordering is a compile error and no probe is needed. That shape is not used here: this step
 * owes a DEMONSTRATED move probe, and a guard whose relocation cannot compile cannot be probed —
 * which is how Block B's `checkOptionalBound` sat block-scoped inside an `if`, unprobeable, while
 * a move test would have passed forever proving nothing. Relocating this call below the DROP
 * compiles and runs, and the probe beside it shows the post-state going red when it does.
 */
export const assertResetTargetIsDisposable = async (
  connection: IdentifiableConnection,
  context: { appEnv: AppEnvironment; databaseUrl: string; redisUrl: string | null },
): Promise<void> => {
  const refuseIf = (refusal: ResetRefusal | null): void => {
    if (refusal) {
      throw new ResetRefused(refusal);
    }
  };

  refuseIf(findEnvironmentRefusal(context.appEnv));
  refuseIf(findConnectionHostRefusal(context.databaseUrl, "DATABASE_URL"));

  if (context.redisUrl !== null) {
    refuseIf(findConnectionHostRefusal(context.redisUrl, "REDIS_URL"));
  }

  const rows = await connection.unsafe("select current_database() as db, current_user as usr");
  const identity = rows[0];

  // An empty result is not "no objection". A server that answered nothing has not been identified,
  // and an unidentified server is the one case this must never wave through.
  if (!identity || typeof identity.db !== "string") {
    throw new ResetRefused({
      layer: "database-identity",
      message:
        "refusing to reset: connected, but the server returned no identity row, so the database " +
        "about to be dropped has not been named by anything.",
    });
  }

  refuseIf(findDatabaseNameRefusal(identity.db));

  console.log(
    `reset target: database "${identity.db}" as "${String(identity.usr)}" ` +
      `(APP_ENV=${context.appEnv}, host=${parseDatabaseHost(context.databaseUrl) ?? "<unparseable>"})`,
  );
};
