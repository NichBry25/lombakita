# Live concurrency race verification

Each script here proves that a guard in the codebase — an advisory lock, a compare-and-set, or a
unique index — actually serializes **two genuinely concurrent Postgres transactions**.

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
node --import tsx scripts/concurrency/mfa-factor-races.ts
node --import tsx scripts/concurrency/finance-idempotency-races.ts   # FINANCE-T1
```

`npm run verify:concurrency` runs all of them (glob-picked, so a new script here joins the nightly
workflow with no further wiring).

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
- **An isolated checker for the guard-removed run** (`finance-idempotency-races.ts`) — where the
  guard-removal proof re-runs a race that is *expected* to fail, pass that run a throwaway
  `createChecker()`. Its failures are the evidence; counting them into the script's own checker
  makes a successful proof exit 1.

## Removing a guard to prove it load-bearing

`finance-idempotency-races.ts` takes `PROVE_GUARD_REMOVAL=1`, and two things it does are worth
copying rather than rediscovering:

- **DDL needs `MIGRATION_DATABASE_URL`.** This project splits privileges — the app role owns
  nothing, so dropping an index over the app's own pool fails with SQLSTATE 42501. Open a second
  connection from the migration role; do not widen the app role.
- **Restore has to be verified, and duplicates deleted first.** A `UNIQUE` index cannot be rebuilt
  over the rows the probe just created, so the probe deletes its own rows before the `CREATE` and
  then confirms the index in `pg_indexes` rather than assuming the statement worked. This one
  removes a uniqueness guarantee from a financial table; "I ran the restore" is not evidence.

A finding worth keeping from that probe: dropping the index does **not** produce duplicate rows —
`onConflictDoNothing({ target })` compiles to `ON CONFLICT (idempotency_key)`, and Postgres refuses
that clause outright (SQLSTATE 42P10) when no unique index matches it. The index is not a check the
write path consults; it is structurally required for the write path to run at all.
