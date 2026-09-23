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
 *
 * ONE GUARD, THREE LANES. The reset drops every table; the deletion runner deletes one account; the
 * provisioning runner writes operator rows. All three ask the same three questions of the same
 * connection, so the questions live here once and the ANSWER IS PHRASED IN THE ASKER'S VERB — a
 * `GuardedVerb` parameter, not a constant. See `refusalPrefix`.
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

/**
 * The operation a guarded connection is about to perform, as the caller's own word for it.
 *
 * The three layers below are one guard with three callers, and a refusal is only readable if it
 * names what it refused. Before this, every message said "refusing to reset" whoever asked — so the
 * deletion runner told its operator that a *reset* had been refused, which is a different operation
 * with a different blast radius (LAUNCH-D144). The word is a parameter now, and the reset lane's own
 * bytes are unchanged by it.
 */
export type GuardedVerb = "reset" | "delete" | "provision";

/** Every message this module produces opens with this, so a caller reads its own operation refused. */
const refusalPrefix = (verb: GuardedVerb): string => `refusing to ${verb}: `;

export type ResetRefusal = {
  /**
   * Which layer refused, so a probe can assert it went red for the reason it claims.
   *
   * The last two are not safety layers and are named separately for that reason. They decide WHICH
   * database the three layers above will then be asked about, and a refusal from either one means
   * the guarded question was never put. Reporting them under a safety layer's name is what produced
   * a false reading: an operator pointing one variable at a protected target to exercise
   * `database-identity` makes the two addresses disagree, `target-coherence` refuses first, and an
   * unlabelled `REFUSED` reads as the identity layer having done its job.
   */
  layer:
    | "database-identity"
    | "environment"
    | "connection-host"
    | "target-configuration"
    | "target-coherence";
  message: string;
};

/**
 * Refuses a database this must never reach, by the name the SERVER reported.
 *
 * Takes the name rather than a connection string on purpose: passing a URL here would make it
 * possible to call this with the string instead of the server's answer, which is the whole defect
 * it exists to prevent.
 */
export const findDatabaseNameRefusal = (
  verb: GuardedVerb,
  databaseName: string,
): ResetRefusal | null => {
  if (!PROTECTED_DATABASE_NAMES.includes(databaseName)) {
    return null;
  }

  return {
    layer: "database-identity",
    message:
      `${refusalPrefix(verb)}the server on this connection reports current_database() = ` +
      `"${databaseName}", which is a protected database (${PROTECTED_DATABASE_NAMES.join(", ")}). ` +
      "This is the database's own answer, not the connection string's, so there is no value to " +
      "correct here other than where this process is pointed.",
  };
};

export const findEnvironmentRefusal = (
  verb: GuardedVerb,
  appEnv: AppEnvironment,
): ResetRefusal | null => {
  if (DISPOSABLE_ENVIRONMENTS.includes(appEnv)) {
    return null;
  }

  return {
    layer: "environment",
    message:
      `${refusalPrefix(verb)}APP_ENV resolves to "${appEnv}", and the ${verb} path runs only in ` +
      `${DISPOSABLE_ENVIRONMENTS.join(" or ")}. There is deliberately no override flag: a ` +
      `${verb} that can be authorised is a ${verb} that will eventually be authorised by mistake.`,
  };
};

export const findConnectionHostRefusal = (
  verb: GuardedVerb,
  url: string,
  variable: string,
): ResetRefusal | null => {
  if (isLoopbackUrl(url)) {
    return null;
  }

  return {
    layer: "connection-host",
    message:
      `${refusalPrefix(verb)}${variable} points at "${parseDatabaseHost(url) ?? "<unparseable>"}", ` +
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

/** Host, port and database name: the part of a connection string that says WHICH database. */
const addressOf = (url: string): string => {
  const parsed = new URL(url);

  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
};

/**
 * The database the reset drops, resolved EXACTLY as drizzle.config.ts resolves the one it migrates.
 *
 * If these two disagreed the reset would drop one database and migrate another, and the second
 * would look like a successful run.
 *
 * Compared by ADDRESS, never as whole strings. The two URLs are expected to differ: locally they
 * carry `lombakita_migrate` and `lombakita_app`, a DDL-capable role and the app's, which is the
 * arrangement working correctly. A string comparison here would refuse every properly configured
 * machine and be "fixed" by deleting the check.
 *
 * Lives beside the three safety layers because it now speaks their language (it throws
 * `ResetRefused` with its own layer tag), and because a refusal that cannot be unit-tested is a
 * refusal whose message nobody checks. `reset-local.ts` runs `main()` at module scope, so nothing
 * can import from it to test.
 */
export const resolveResetTarget = (verb: GuardedVerb): string => {
  // `presentOrUndefined`, never `??`. With `??` an empty MIGRATION_DATABASE_URL is a present value
  // that shadows a correctly set DATABASE_URL, so the target resolved to "" and this refused with
  // "must be set" while DATABASE_URL was set the whole time: fail-closed, but naming a cause the
  // operator could not act on.
  const migrationUrl = presentOrUndefined(process.env.MIGRATION_DATABASE_URL);
  const databaseUrl = presentOrUndefined(process.env.DATABASE_URL);
  const target = migrationUrl ?? databaseUrl;

  if (!target) {
    throw new ResetRefused({
      layer: "target-configuration",
      message:
        `${refusalPrefix(verb)}neither DATABASE_URL nor MIGRATION_DATABASE_URL names a database, ` +
        "so there is nothing for the identity, environment and host layers to be asked about.",
    });
  }

  // A coherence check, not a safety guard: dropping the migration database while the app reads a
  // different one leaves a reset that reports success over an untouched application database.
  //
  // Tagged as its own layer because it is routinely mistaken for the identity layer. Pointing one
  // variable at a protected database to exercise `database-identity` is exactly what makes the two
  // addresses disagree, so this refuses first and the run never reaches the check being tested.
  if (migrationUrl && databaseUrl && addressOf(migrationUrl) !== addressOf(databaseUrl)) {
    throw new ResetRefused({
      layer: "target-coherence",
      message:
        `${refusalPrefix(verb)}MIGRATION_DATABASE_URL points at ${addressOf(migrationUrl)} and ` +
        `DATABASE_URL at ${addressOf(databaseUrl)}. The ${verb} would drop one and leave the app ` +
        "pointed at the other. Point them at the same database.\n" +
        "This is the coherence check, NOT the database-identity layer. If you changed one variable " +
        "to exercise identity, point both at that database instead; otherwise this refuses first " +
        "and the identity layer is never reached.",
    });
  }

  return target;
};

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
  context: {
    verb: GuardedVerb;
    appEnv: AppEnvironment;
    databaseUrl: string;
    redisUrl: string | null;
  },
): Promise<void> => {
  const refuseIf = (refusal: ResetRefusal | null): void => {
    if (refusal) {
      throw new ResetRefused(refusal);
    }
  };

  refuseIf(findEnvironmentRefusal(context.verb, context.appEnv));
  refuseIf(findConnectionHostRefusal(context.verb, context.databaseUrl, "DATABASE_URL"));

  if (context.redisUrl !== null) {
    refuseIf(findConnectionHostRefusal(context.verb, context.redisUrl, "REDIS_URL"));
  }

  const rows = await connection.unsafe("select current_database() as db, current_user as usr");
  const identity = rows[0];

  // An empty result is not "no objection". A server that answered nothing has not been identified,
  // and an unidentified server is the one case this must never wave through.
  if (!identity || typeof identity.db !== "string") {
    throw new ResetRefused({
      layer: "database-identity",
      message:
        `${refusalPrefix(context.verb)}connected, but the server returned no identity row, so ` +
        "the database about to be dropped has not been named by anything.",
    });
  }

  refuseIf(findDatabaseNameRefusal(context.verb, identity.db));

  console.log(
    `${context.verb} target: database "${identity.db}" as "${String(identity.usr)}" ` +
      `(APP_ENV=${context.appEnv}, host=${parseDatabaseHost(context.databaseUrl) ?? "<unparseable>"})`,
  );
};
