# Live concurrency race verification

Each script here proves that a guard in the codebase — an advisory lock or a compare-and-set —
actually serializes **two genuinely concurrent Postgres transactions**.

The unit suite cannot prove this. It mocks the database, so `tx.execute` is a no-op: a unit test can
assert that a lock key is derived correctly and that the lock is taken *before* the count it
protects, which is real value, but delete `pg_advisory_xact_lock` from a service and the whole suite
stays green.

## Running them

Local Postgres must be up (`DATABASE_URL` from `.env.local`). Railway is not required.

```bash
node --import tsx scripts/verify-owner-cap-concurrency.ts              # per-owner cap, create sites
node --import tsx scripts/concurrency/upgrade-owner-cap.ts             # per-owner cap, upgrade site
node --import tsx scripts/concurrency/institution-verification-submission.ts
node --import tsx scripts/concurrency/registration-document-request.ts
node --import tsx scripts/concurrency/verification-cas-races.ts
node --import tsx scripts/concurrency/competition-participation.ts
```

Each exits 0 only when every check passes, seeds and cleans up its own rows, and refuses to report a
result unless the database is READ COMMITTED — every post-lock count and every CAS in this codebase
is reasoned about under that isolation level.

`RACE_ITERATIONS=20` raises the iteration count, which is useful when probing a narrow interleaving.

## Writing another one

Copy the shape of an existing script rather than inventing one. The things that are easy to get
wrong, and that will silently produce a test proving nothing:

- **Pool width.** `openPool()` uses `max: 8` so concurrent transactions land on separate backends.
  With `max: 1` the racers serialize on the connection and every assertion passes on nothing.
- **Drive the service functions, not the HTTP layer.** A route-level guard masks a service-level
  race.
- **Include a control.** Two *different* owners / institutions / competitions must both succeed. A
  lock keyed on a constant — accidentally global — passes every other assertion.
- **A skipped assertion is not a satisfied one.** If a barrier cannot be observed holding, or a
  racer cannot run, make the check FAIL. Never let it fall through to a pass.
- **Run it once with the guard deleted and confirm it fails.** That is the only evidence the test is
  load-bearing.

Two techniques beyond the basic shape, both already implemented here:

- **`raceBehindRowLock`** (`verification-cas-races.ts`) — a CAS race needs both transactions to have
  read the row before either commits. A third connection holds `SELECT … FOR UPDATE` on the
  contended row; both racers park at their UPDATE with their snapshots already taken. It also
  **staggers** the starts: Postgres grants a contended row lock in arrival order, so starting both
  at once always hands the win to whichever operation does less work before its UPDATE, and one of
  the two legal outcomes never gets exercised.
- **A pinned clock** (`competition-participation.ts`) — where a DB constraint makes the overlap
  between two operations a single instant, pin each racer's injectable `now` either side of that
  boundary. This reproduces the production interleaving; it does not invent one.
