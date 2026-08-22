/**
 * Whether a database connection string points at a loopback host.
 *
 * Its own module, deliberately: `live-harness.ts` reads `.env.local` and throws on a missing
 * `DATABASE_URL` at import time, so importing it to reach this predicate would make a pure unit test
 * depend on an environment it does not need. Nothing here has a side effect.
 */

// `new URL(...).hostname` returns an IPv6 literal WITH its brackets: "[::1]", not "::1". Comparing
// against the bare form alone silently never matches, which fails closed (a local IPv6 database is
// refused as remote) and is therefore invisible until someone runs one.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const parseDatabaseHost = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

// An unparseable string is reported non-local: a caller uses this to decide whether it may write,
// and a string this cannot read is not one to write through.
export const isLocalDatabaseHost = (url: string): boolean => {
  const host = parseDatabaseHost(url);

  return host !== null && LOOPBACK_HOSTS.has(host);
};
