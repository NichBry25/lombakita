/**
 * Whether a database connection string points at a loopback host.
 *
 * Its own module, deliberately: `live-harness.ts` reads `.env.local` and throws on a missing
 * `DATABASE_URL` at import time, so importing it to reach this predicate would make a pure unit test
 * depend on an environment it does not need. Nothing here has a side effect.
 *
 * The implementation lives in `loopback-host.mjs` because the probe harness is plain `.mjs` run
 * under plain node and cannot import a `.ts` module. This file is the typed name for the same
 * functions, not a second copy of them.
 */

export { isLoopbackUrl, parseDatabaseHost } from "./loopback-host.mjs";

// The same predicate under the name its first caller gave it. Nothing about the check is specific
// to Postgres (a redis:// URL parses identically), so the harness guard reads `isLoopbackUrl` for
// both of the connection strings it refuses, and the finance scripts keep the name they import.
export { isLoopbackUrl as isLocalDatabaseHost } from "./loopback-host.mjs";
