/**
 * Empties the local finance tables, and the fixture rows the concurrency harness mints, so a
 * migration that requires them empty can run.
 *
 * WHY THIS EXISTS. Step 7.2-MANUAL.1 adds `finance_payments.origin` as NOT NULL with no default and
 * no backfill, which requires the table to hold no rows. A local development database accumulates
 * rows anyway, from concurrency and verification scripts that seed real payments and whose teardown
 * a Ctrl-C skips. Clearing that residue is an OPERATOR action performed by an operator's script.
 *
 * WHAT THIS IS NOT. It is not a delete path for the ledger, and nothing under `src/` gains one.
 * DEC-0133 makes the finance ledger append-only by forbidding any APPLICATION code path that updates
 * or deletes a ledger row, an invariant the append-only scan enforces across all of `src/**`. This
 * file lives in `scripts/`, is not reachable from the app, and removes fixture rows left by other
 * scripts. If you are reading this while looking for a way to delete a payment from a running
 * system: there isn't one, and adding one here would not give you one.
 *
 * LOCAL DATABASES ONLY, checked rather than documented. The distinction between "fixture residue"
 * and "the ledger" is a fact about which database is connected, not about the rows themselves.
 * They are the same shape. A pasted connection string is all it would take, so the host is verified
 * before anything is read, let alone deleted.
 *
 * FIXTURE ROWS ARE MATCHED BY THE PATTERN THE HARNESS MINTS THEM WITH, never by "everything that
 * looks unused". `fin_<hex>@example.test` users and `fin-inst-<hex>` institutions are generated in
 * `scripts/concurrency/finance-idempotency-races.ts`; nothing else in the app produces either shape.
 *
 * A user whose deletion a foreign key refuses is REPORTED AND LEFT. Those FKs are audit references
 * with no cascade (DEC-0112), and an audit trail that a cleanup script can dissolve is not an audit
 * trail, so the refusal is the design working and is not to be worked around here.
 *
 * Run:  node --import tsx scripts/finance/clear-local-finance-residue.ts          (reports only)
 *       node --import tsx scripts/finance/clear-local-finance-residue.ts --apply  (deletes)
 *
 * Exit code: 0 when every table is empty of everything this script may remove; 1 otherwise.
 */

import { assertLocalDatabase, createChecker, databaseUrl, finish } from "../lib/live-harness";

// Children before parents. Every finance foreign key is ON DELETE NO ACTION, so any other order is
// refused by the database, the same durability that makes the ledger hard to erase from the app.
//
// EVERY NEW FINANCE TABLE BELONGS HERE, ABOVE ITS PARENT. An omission does not degrade quietly: the
// parent's delete fails on the constraint and the whole cleanup aborts, which is how a local
// database becomes unresettable. The attempts table is a child of the proofs table, which is itself
// a child of payments, so the order within the manual-lane block matters as much as the block's
// position above `finance_payments`.
const FINANCE_TABLES_CHILD_FIRST = [
  "finance_manual_payment_proof_attempts",
  "finance_manual_payment_proofs",
  "finance_payment_instruction_snapshots",
  "finance_fee_accruals",
  "finance_payment_events",
  "finance_payments",
  "finance_fee_disclosure_acknowledgements",
  "finance_fee_rules",
];

// `\_` escapes LIKE's single-character wildcard, so this matches a literal underscore rather than
// any character. Passed as a bound parameter, not interpolated.
const FIXTURE_USER_EMAIL = "fin\\_%@example.test";
const FIXTURE_INSTITUTION_SLUG = "fin-inst-%";

const PG_FOREIGN_KEY_VIOLATION = "23503";

type Counts = Record<string, number>;

const main = async (): Promise<void> => {
  assertLocalDatabase(databaseUrl, "clear-local-finance-residue");

  const apply = process.argv.includes("--apply");
  const { default: postgres } = await import("postgres");
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const { check, failureCount } = createChecker();

  const countFinance = async (): Promise<Counts> => {
    const counts: Counts = {};

    for (const table of FINANCE_TABLES_CHILD_FIRST) {
      const [row] = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${client(table)}
      `;
      counts[table] = row?.n ?? 0;
    }

    return counts;
  };

  const countFixtures = async (): Promise<Counts> => {
    const [row] = await client<
      { users: number; institutions: number; competitions: number; registrations: number }[]
    >`
      SELECT
        (SELECT count(*) FROM users WHERE email LIKE ${FIXTURE_USER_EMAIL})::int AS users,
        (SELECT count(*) FROM institutions WHERE slug LIKE ${FIXTURE_INSTITUTION_SLUG})::int AS institutions,
        (SELECT count(*) FROM competitions WHERE institution_id IN
          (SELECT id FROM institutions WHERE slug LIKE ${FIXTURE_INSTITUTION_SLUG}))::int AS competitions,
        (SELECT count(*) FROM competition_registrations WHERE competition_id IN
          (SELECT id FROM competitions WHERE institution_id IN
            (SELECT id FROM institutions WHERE slug LIKE ${FIXTURE_INSTITUTION_SLUG})))::int AS registrations
    `;

    return {
      "fixture registrations": row?.registrations ?? 0,
      "fixture competitions": row?.competitions ?? 0,
      "fixture institutions": row?.institutions ?? 0,
      "fixture users": row?.users ?? 0,
    };
  };

  const report = (label: string, counts: Counts): number => {
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    console.log(`\n${label}`);
    for (const [name, n] of Object.entries(counts)) {
      console.log(`  ${n.toString().padStart(6)}  ${name}`);
    }
    return total;
  };

  // Users deliberately kept because an audit foreign key refused them. Tracked so the exit
  // assertion can tell "left on purpose, and said so" apart from "the DELETE silently did nothing".
  const retainedUserIds: string[] = [];

  const removeFixtures = async (): Promise<void> => {
    await client`
      DELETE FROM competition_registrations WHERE competition_id IN
        (SELECT id FROM competitions WHERE institution_id IN
          (SELECT id FROM institutions WHERE slug LIKE ${FIXTURE_INSTITUTION_SLUG}))
    `;
    await client`
      DELETE FROM competitions WHERE institution_id IN
        (SELECT id FROM institutions WHERE slug LIKE ${FIXTURE_INSTITUTION_SLUG})
    `;
    await client`DELETE FROM institutions WHERE slug LIKE ${FIXTURE_INSTITUTION_SLUG}`;

    // One statement per user rather than one set-based DELETE: a single refusal would otherwise
    // abort the whole statement and strand every other fixture user with it.
    const users = await client<{ id: string; email: string }[]>`
      SELECT id, email FROM users WHERE email LIKE ${FIXTURE_USER_EMAIL}
    `;

    for (const user of users) {
      try {
        await client`DELETE FROM users WHERE id = ${user.id}`;
      } catch (error) {
        const code = (error as { code?: string }).code;

        if (code !== PG_FOREIGN_KEY_VIOLATION) {
          throw error;
        }

        retainedUserIds.push(user.id);
        console.log(`  RETAINED  ${user.email}: referenced by an audit foreign key, left in place`);
      }
    }
  };

  try {
    const financeBefore = await countFinance();
    const fixturesBefore = await countFixtures();

    console.log(`\nLOCAL DATABASE: ${new URL(databaseUrl).hostname}`);
    const total =
      report("Finance tables", financeBefore) + report("Harness fixtures", fixturesBefore);

    if (total === 0) {
      console.log("\nNothing to remove.");
      check(true, "finance tables and harness fixtures are already empty");
    } else if (!apply) {
      console.log(`\n${total} row(s) would be deleted. Re-run with --apply to delete them.`);
      // Not a failure: a report-only run did exactly what was asked of it. The caller learns the
      // count from the output above, and the migration's own gate is what refuses a non-empty table.
      check(true, `reported ${total} residue row(s) without deleting (no --apply)`);
    } else {
      for (const table of FINANCE_TABLES_CHILD_FIRST) {
        await client`DELETE FROM ${client(table)}`;
      }

      await removeFixtures();

      // The DELETEs having returned is not evidence that anything went away. This is.
      const financeAfter = await countFinance();
      const fixturesAfter = await countFixtures();

      for (const [table, n] of Object.entries(financeAfter)) {
        check(n === 0, `${table} is empty on exit (${n} row(s))`);
      }

      for (const [name, n] of Object.entries(fixturesAfter)) {
        const expected = name === "fixture users" ? retainedUserIds.length : 0;
        check(
          n === expected,
          expected === 0
            ? `${name}: none remain on exit (${n} row(s))`
            : `${name}: only the ${expected} row(s) an audit FK refused remain on exit (${n} row(s))`,
        );
      }

      if (retainedUserIds.length > 0) {
        console.log(
          `\n${retainedUserIds.length} fixture user(s) left in place, an audit foreign key ` +
            "references them, and audit rows are not deleted to make a cleanup tidier.",
        );
      }
    }
  } finally {
    await client.end();
  }

  finish(failureCount(), "FINANCE RESIDUE CLEANUP");
};

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
