# Finance ledger verification

One script, `verify-payment-ledger.ts`, which is **Step 7.1's manual test** (loop step 7b).

```bash
node --import tsx scripts/finance/verify-payment-ledger.ts
# or
npm run verify:finance
```

Exits 0 when every check passes, 1 otherwise, and prints one PASS/FAIL line per check.

## Why this is a script and not a browser checklist

Step 7.1 ships schema, enums, a migration and two server-side services. There is **no page, no
route and no button** — so a checklist written for a browser would have nothing to click. The six
business rules the step exists to guarantee can only be observed by driving the real services
against a real database and reading back what was recorded.

It is also not a restatement of the unit suite. The unit suite mocks the database, which makes a
CHECK constraint, a unique index and a NOT NULL structurally invisible to it — deleting every
constraint from `schema.ts` leaves it green. Every property asserted here lives in the database or
in the interaction between the service and the database, which is the half no mocked test reaches.

## What it checks

Each section is one of the six manual test seeds, phrased as the product rule rather than as the
schema:

| # | Product rule | What it proves |
|---|---|---|
| 1 | Every payment names who receives the money | The recipient is on the row, and a payment that cannot name one is refused by the database rather than by convention |
| 2 | The platform is a facilitator, not a holder | Fee + net = gross to the rupiah, and **no column in the finance schema means "what the platform currently holds"** — asserted against `information_schema`, so it stays true as the schema grows |
| 3 | Yesterday's money is not rewritten by today's pricing | The fee rule is quadrupled *after* the payment is recorded; the payment is unchanged |
| 4 | A retried operation charges once | A repeated append under one key records nothing new — and reusing that key for a *different* operation is refused rather than silently swallowed |
| 5 | A refund never erases history | After a full refund the original capture is still readable with its amount intact, and the refund records why the money moved |
| 6 | A correction is visible as a correction | The correction is its own row naming a person and a reason; nothing was removed; it is reported separately from what was captured |

A seventh section checks the tenant boundary: a different institution asking for the same payment
gets nothing.

## Notes for whoever runs or extends it

- **It seeds against the database `DATABASE_URL` points at and cleans up afterwards.** Unlike the
  DB-backed vitest suite it does not run inside a rolled-back transaction, because rule 3 needs a
  committed rate change to be meaningful. Teardown is verified — run the counts yourself if a run
  fails midway, since a failure between seed and teardown can leave rows behind.
- **Teardown must run children before parents.** Every finance foreign key is `ON DELETE no action`,
  so any other order is refused. That refusal is the ledger's durability working, not an obstacle.
- Teardown deletes finance rows by raw SQL. The application must never do this and cannot — the
  append-only scan in `payment-service.append-only.test.ts` covers all of `src/**`. These are
  seeded fixtures, not a ledger anyone relies on.
- **Timestamps in the hand-written seed SQL go in as ISO strings.** Drizzle binds a JS `Date`; the
  raw `postgres.js` client used for seeding does not, and fails with an opaque
  `ERR_INVALID_ARG_TYPE` naming `Buffer.byteLength` rather than the column.
- Do **not** point this at preview or production. It writes rows and mutates a fee rule.
