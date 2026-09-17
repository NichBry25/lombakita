/**
 * Seeds the manual payment lane on top of an already-seeded matrix.
 *
 *   node --import tsx scripts/seed-manual-payment-lane.ts
 *
 * SEPARATE FROM `seed-test-matrix.ts` AND FROM `npm run db:reset`, deliberately. A reset produces a
 * database with no finance rows at all, and the matrix seed asserts that. Run this only when the
 * bukti-transfer lane is what you are testing, and understand before you do that what it writes
 * cannot be taken back:
 *
 *   - DEC-0133 makes `finance_payments`, `finance_payment_events` and `finance_fee_accruals`
 *     APPEND-ONLY. There is no cleanup path. Every other table the seed touches is recoverable by
 *     deleting `seed-%` rows; a seeded ledger row is permanent in whatever database receives it.
 *   - Migration 0058 REFUSES to run against a non-empty `finance_payments` (DEC-0165 forbids
 *     backfilling `origin`). An environment receiving seeded payments before 0058 lands there can
 *     never have 0058 applied, and 0058 has not reached preview or production.
 *   - The emptiness of `finance_payments` in every deployed environment is a PREMISE the
 *     migration-ordering analysis rests on. This script is the writer that analysis assumed did not
 *     exist.
 *
 * Those three reasons moved here with the rows they are about. They used to sit in the matrix
 * seed's refusal, which has not written a finance row since the lane was split out; a guard whose
 * stated reason is no longer true is a guard nobody can evaluate.
 */

import { seedManualPaymentLane, resetManualPaymentLaneScratch } from "./seed/manual-payment-lane";
import { assertSeedTargetIsDisposable, resolveSeedDatabaseUrl } from "./seed/seed-target";

const databaseUrl = resolveSeedDatabaseUrl(
  "This script writes finance_payments rows, and DEC-0133 makes those APPEND-ONLY. There is no " +
    "path to remove them afterwards from any environment that receives them. Seeded payments also " +
    "make migration 0058 permanently unapplicable there (it refuses a non-empty finance_payments, " +
    "per DEC-0165).",
);

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = Date.now();
const d = (days: number): Date => new Date(now + days * DAY);
const h = (hours: number): Date => new Date(now + hours * HOUR);

const main = async (): Promise<void> => {
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { max: 1, prepare: false });

  try {
    await assertSeedTargetIsDisposable(sql, databaseUrl);
    console.log("  target is disposable; seeding the money lane");

    // Refuses rather than producing an orphaned lane. Every payment names a registration and an
    // institution the matrix seed creates, so running this first fails on a foreign key partway
    // through and leaves a half-written ledger nothing can remove.
    const [matrix] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM competition_registrations WHERE id LIKE 'seed-reg-%'
    `;

    if ((matrix?.n ?? 0) === 0) {
      throw new Error(
        "the matrix seed has not run against this database, so the registrations these payments " +
          "name do not exist. Run `node --import tsx scripts/seed-test-matrix.ts` first; this " +
          "lane writes append-only ledger rows and a partial run cannot be undone.",
      );
    }

    await seedManualPaymentLane(sql, { d, h });
    await resetManualPaymentLaneScratch(sql);

    const counts = await sql<{ label: string; n: number }[]>`
      SELECT 'payments' AS label, count(*)::int AS n FROM finance_payments WHERE id LIKE 'seed-pay-%'
      UNION ALL SELECT 'payment_proofs', count(*)::int FROM finance_manual_payment_proofs WHERE id LIKE 'seed-proof-%'
    `;
    for (const row of counts) console.log(`${row.label.padEnd(18)} ${row.n}`);
    console.log("Manual payment lane seeded.");
  } finally {
    await sql.end();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
