// Test-only. The one predicate that says whether a database is MANDATORY for a test run, kept on its
// own because two callers need it and only one of them can pay for the rest.
//
// It lived in `database-url.ts` until LAUNCH-D156. That module resolves a connection string and
// throws at module load when one is required and absent (DEC-0142's tripwire), which is right for a
// suite and wrong for the test runner itself: the reporter that fails a run carrying skipped or empty
// files reads this predicate from the main process, before any test has been collected, and a throw
// there replaces every suite's own clear failure with one internal reporter-load error.
//
// The alternative was a second spelling of `REQUIRE_DB_TESTS !== "0"` in the reporter, which is the
// duplication Rule 37 forbids: two definitions of one rule drift, and the drift would be silent in
// whichever direction was not being exercised.

export const databaseTestsRequired = process.env.REQUIRE_DB_TESTS !== "0";
