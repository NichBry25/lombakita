/*
 * Whether a connection string points at a loopback host.
 *
 * PLAIN JAVASCRIPT ON PURPOSE, and this is the whole reason the module exists in this form. Two
 * kinds of caller need this predicate: TypeScript modules run through tsx, and the `.mjs` probe
 * harness run through plain node. A `.ts` module cannot be imported from `.mjs` under plain node,
 * and under tsx it arrives as a CommonJS default export while vitest gives it named exports, so no
 * single import line serves both. A `.mjs` module is real ESM to every one of them.
 *
 * `local-database-host.ts` re-exports this so its existing importers are unaffected and the typed
 * name stays available. There is one implementation, here.
 *
 * Nothing in this file has a side effect.
 */

// `new URL(...).hostname` returns an IPv6 literal WITH its brackets: "[::1]", not "::1". Comparing
// against the bare form alone silently never matches, which fails closed (a local IPv6 database is
// refused as remote) and is therefore invisible until someone runs one.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const parseDatabaseHost = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

// An unparseable string is reported non-local: a caller uses this to decide whether it may write,
// and a string this cannot read is not one to write through.
export const isLoopbackUrl = (url) => {
  const host = parseDatabaseHost(url);

  return host !== null && LOOPBACK_HOSTS.has(host);
};
