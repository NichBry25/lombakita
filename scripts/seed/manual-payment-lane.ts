/**
 * The manual payment lane's rows, moved out of the matrix seed and DELIBERATELY NOT ROUTED.
 *
 * WHY THIS IS A SEPARATE MODULE AND NOT A SECTION. Every other row the seed writes now travels the
 * service production uses; these do not, and the difference has to be visible in the file tree
 * rather than asserted in a comment. Phase 2 routes the matrix; the money lane is Phase 4's, and
 * until then its rows are written directly and that fact is declared here.
 *
 * WHY IT CANNOT SIMPLY BE ROUTED LATER EITHER, without a decision that belongs to Phase 4:
 *   - DEC-0133 makes `finance_payments`, `finance_payment_events` and `finance_fee_accruals`
 *     APPEND-ONLY. A routed seed that is re-runnable has to remove what it wrote; these rows cannot
 *     be removed, so the routed seed's teardown could not cover them even if the writes travelled.
 *   - Several rows exist precisely BECAUSE the service refuses them. `seed-comp-b-unpayable` is
 *     priced while its institution meets none of the charging conditions, and the refusal is the
 *     fixture. Routing it would delete the state it exists to produce.
 *
 * NOT CALLED BY THE MATRIX SEED, and not called by `npm run db:reset`. A database that has been
 * reset holds no finance rows at all, which is the post-condition the reset asserts. Run this
 * separately when the manual-payment lane is what you are testing.
 *
 * The competition price UPDATEs travel with the block rather than staying behind. They write
 * `competitions`, not a finance table, but they are the lane's own setup (a payment cannot exist
 * against an unpriced competition), and splitting them would leave the matrix seed writing the one
 * part of the money lane that looks harmless.
 */

import { Table, getTableName, is } from "drizzle-orm";
import type { Sql } from "postgres";
import * as schema from "@/server/db/schema";
import { institutionPaymentInstructions } from "@/server/db/schema";

/**
 * Writes the manual payment lane against an already-seeded matrix.
 *
 * Takes the connection rather than opening one, so the caller owns the lifetime and this cannot be
 * run against a database the caller did not already decide was disposable.
 */
export const seedManualPaymentLane = async (
  sql: Sql,
  dates: { d: (days: number) => Date; h: (hours: number) => Date },
): Promise<void> => {
  const { d, h } = dates;

  // --------------------------------------------------------- manual payment lane
  // Everything the bukti transfer lane needs, in the three states a candidate can be in. Seeded
  // as a block rather than scattered because the lane has an ORDER: a competition cannot be
  // priced without a fee rule to resolve, and a priced payment cannot be created without the
  // institution having published somewhere to send the money.
  await sql`
    UPDATE competitions
    SET fee_amount = 150000, fee_currency = 'IDR', payment_window_days = 3, updated_at = now()
    WHERE id = 'seed-comp-paid'
  `;

  // Priced, published, and owned by an institution with none of the three charging conditions
  // met. Written directly because the service layer would refuse, and that refusal is the point.
  await sql`
    UPDATE competitions
    SET fee_amount = 75000, fee_currency = 'IDR', payment_window_days = 3, updated_at = now()
    WHERE id = 'seed-comp-b-unpayable'
  `;

  // SCOPED TO seed-inst-a, deliberately NOT a platform default (institution_id NULL).
  //
  // A platform-wide rule is a global fallback. It resolves for every institution in the
  // database, including fixtures built by other suites. Seeding one made "no fee rule is in
  // force" unreachable and broke two real-database tests that assert the charging gate fails
  // closed without one. Scoping it here keeps the seed institution priceable without changing
  // what any other tenant resolves.
  await sql`
    INSERT INTO finance_fee_rules (id, institution_id, currency, basis_points, flat_amount,
      effective_from)
    VALUES ('seed-feerule-default', 'seed-inst-a', 'IDR', 250, 0, ${d(-90)})
    ON CONFLICT (id) DO NOTHING
  `;

  await sql`
    INSERT INTO institution_payment_instructions (id, institution_id, bank_name, account_number,
      account_holder_name, instructions_note)
    VALUES ('seed-payinstr-a', 'seed-inst-a', 'Bank Mandiri', '1370012345678',
      'Yayasan Seed Academy',
      'Cantumkan nama lengkap dan nama kompetisi pada berita transfer.')
    ON CONFLICT (institution_id) DO UPDATE SET
      bank_name = EXCLUDED.bank_name, account_number = EXCLUDED.account_number,
      account_holder_name = EXCLUDED.account_holder_name,
      instructions_note = EXCLUDED.instructions_note, updated_at = now()
  `;

  // One payment per registration, each carrying its own deadline snapshot and its own copy of the
  // account details, never a reference to the institution's live row, so an organiser changing
  // banks cannot repoint a payer who is mid-transfer.
  type PaySeed = { id: string; reg: string; payer: string; dueAt: Date };
  const payments: PaySeed[] = [
    { id: "seed-pay-a", reg: "seed-reg-a-paid", payer: "seed-user-cand-a", dueAt: d(2) },
    { id: "seed-pay-b", reg: "seed-reg-b-paid", payer: "seed-user-cand-b", dueAt: d(2) },
    { id: "seed-pay-c", reg: "seed-reg-c-paid", payer: "seed-user-cand-c", dueAt: d(2) },
    { id: "seed-pay-d-settled", reg: "seed-reg-d-paid", payer: "seed-user-cand-d", dueAt: d(2) },
  ];
  for (const pay of payments) {
    await sql`
      INSERT INTO finance_payments (id, payer_user_id, receiving_institution_id, origin,
        subject_type, competition_registration_id, currency, gross_amount, fee_rule_id,
        fee_basis_points, fee_flat_amount, platform_fee_amount, institution_net_amount, due_at)
      VALUES (${pay.id}, ${pay.payer}, 'seed-inst-a', 'manual_transfer',
        'competition_registration', ${pay.reg}, 'IDR', 150000, 'seed-feerule-default',
        250, 0, 0, 150000, ${pay.dueAt})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO finance_payment_instruction_snapshots (id, payment_id, bank_name,
        account_number, account_holder_name, instructions_note)
      VALUES (${`seed-paysnap-${pay.id}`}, ${pay.id}, 'Bank Mandiri', '1370012345678',
        'Yayasan Seed Academy',
        'Cantumkan nama lengkap dan nama kompetisi pada berita transfer.')
      ON CONFLICT (payment_id) DO NOTHING
    `;
  }

  // Institution D's own pricing, instructions and payment. A DIFFERENT account number on purpose:
  // if a verdict or a read ever crosses the boundary, the wrong bank details are the visible
  // symptom, whereas two tenants sharing "1370012345678" would leak silently.
  await sql`
    UPDATE competitions
    SET fee_amount = 90000, fee_currency = 'IDR', payment_window_days = 3, updated_at = now()
    WHERE id = 'seed-comp-d-paid'
  `;
  await sql`
    INSERT INTO finance_fee_rules (id, institution_id, currency, basis_points, flat_amount,
      effective_from)
    VALUES ('seed-feerule-d', 'seed-inst-d', 'IDR', 250, 0, ${d(-60)})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO institution_payment_instructions (id, institution_id, bank_name, account_number,
      account_holder_name, instructions_note)
    VALUES ('seed-payinstr-d', 'seed-inst-d', 'Bank BCA', '8880099887766',
      'Kolektif Seed Nusantara', 'Transfer sebelum batas waktu, sertakan nama peserta.')
    ON CONFLICT (institution_id) DO UPDATE SET
      bank_name = EXCLUDED.bank_name, account_number = EXCLUDED.account_number,
      account_holder_name = EXCLUDED.account_holder_name,
      instructions_note = EXCLUDED.instructions_note, updated_at = now()
  `;
  await sql`
    INSERT INTO finance_payments (id, payer_user_id, receiving_institution_id, origin,
      subject_type, competition_registration_id, currency, gross_amount, fee_rule_id,
      fee_basis_points, fee_flat_amount, platform_fee_amount, institution_net_amount, due_at)
    VALUES ('seed-pay-d', 'seed-user-cand-a', 'seed-inst-d', 'manual_transfer',
      'competition_registration', 'seed-reg-a-dpaid', 'IDR', 90000, 'seed-feerule-d',
      250, 0, 0, 90000, ${d(2)})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO finance_payment_instruction_snapshots (id, payment_id, bank_name,
      account_number, account_holder_name, instructions_note)
    VALUES ('seed-paysnap-seed-pay-d', 'seed-pay-d', 'Bank BCA', '8880099887766',
      'Kolektif Seed Nusantara', 'Transfer sebelum batas waktu, sertakan nama peserta.')
    ON CONFLICT (payment_id) DO NOTHING
  `;
  // Awaiting review, so it is a proof an outsider could plausibly try to rule on. A proof already
  // closed would be refused by the CAS for a reason that has nothing to do with tenancy, and the
  // boundary test would pass without the boundary.
  await sql`
    INSERT INTO finance_manual_payment_proofs (id, payment_id, competition_id,
      submitted_by_user_id, status, r2_key, original_file_name, file_size_bytes, content_type,
      submitted_at)
    VALUES ('seed-proof-d', 'seed-pay-d', 'seed-comp-d-paid', 'seed-user-cand-a',
      'pending_review', 'payment-proofs/seed-comp-d-paid/seed-pay-d/seed-bukti-d',
      'bukti-transfer-andi-kolektif.jpg', 152064, 'image/jpeg', ${h(-8)})
    ON CONFLICT (payment_id) DO UPDATE SET
      status = EXCLUDED.status, submitted_at = EXCLUDED.submitted_at,
      reviewer_user_id = NULL, reviewed_at = NULL, rejection_reason = NULL,
      resubmission_allowed = true, resubmission_count = 0, updated_at = now()
  `;

  // Candidate A: nothing sent, the "awaiting_transfer" state, so A's panel shows the upload form.
  // Candidate B: evidence with the organiser, "awaiting_review".
  // Candidate C: refused with the door left open, "rejected_resubmittable".
  // Together they also give the organiser's review queue one row in each state.
  await sql`
    INSERT INTO finance_manual_payment_proofs (id, payment_id, competition_id,
      submitted_by_user_id, status, r2_key, original_file_name, file_size_bytes, content_type,
      submitted_at)
    VALUES ('seed-proof-b', 'seed-pay-b', 'seed-comp-paid', 'seed-user-cand-b', 'pending_review',
      'payment-proofs/seed-comp-paid/seed-pay-b/seed-bukti-b', 'bukti-transfer-bela.jpg',
      184320, 'image/jpeg', ${h(-6)})
    ON CONFLICT (payment_id) DO UPDATE SET
      status = EXCLUDED.status, submitted_at = EXCLUDED.submitted_at,
      reviewer_user_id = NULL, reviewed_at = NULL, rejection_reason = NULL,
      resubmission_allowed = true, resubmission_count = 0, updated_at = now()
  `;
  await sql`
    INSERT INTO finance_manual_payment_proofs (id, payment_id, competition_id,
      submitted_by_user_id, status, r2_key, original_file_name, file_size_bytes, content_type,
      submitted_at, reviewer_user_id, reviewed_at, rejection_reason, resubmission_allowed)
    VALUES ('seed-proof-c', 'seed-pay-c', 'seed-comp-paid', 'seed-user-cand-c', 'rejected',
      'payment-proofs/seed-comp-paid/seed-pay-c/seed-bukti-c', 'bukti-transfer-cindy.jpg',
      96256, 'image/jpeg', ${h(-30)}, 'seed-user-rec-elev', ${h(-20)},
      'Nominal transfer tidak sesuai, tertera Rp100.000, seharusnya Rp150.000.', true)
    ON CONFLICT (payment_id) DO UPDATE SET
      status = EXCLUDED.status, reviewer_user_id = EXCLUDED.reviewer_user_id,
      reviewed_at = EXCLUDED.reviewed_at, rejection_reason = EXCLUDED.rejection_reason,
      resubmission_allowed = EXCLUDED.resubmission_allowed, resubmission_count = 0,
      updated_at = now()
  `;
  // Candidate D: SETTLED. The only seeded row in the state a completed manual payment ends in.
  //
  // It carries its own payment (`seed-pay-d-settled`) precisely because the ledger cannot be
  // rewound: verifying writes a `succeeded` event and a fee accrual into append-only tables, and
  // the reset below deletes neither. Attaching this state to an existing payment would make that
  // payment permanently settled in any database this script has ever touched.
  await sql`
    INSERT INTO finance_manual_payment_proofs (id, payment_id, competition_id,
      submitted_by_user_id, status, r2_key, original_file_name, file_size_bytes, content_type,
      submitted_at, reviewer_user_id, reviewed_at)
    VALUES ('seed-proof-d-settled', 'seed-pay-d-settled', 'seed-comp-paid', 'seed-user-cand-d',
      'verified', 'payment-proofs/seed-comp-paid/seed-pay-d-settled/seed-bukti-dewi',
      'bukti-transfer-dewi.pdf', 208896, 'application/pdf', ${h(-52)},
      'seed-user-rec-elev', ${h(-44)})
    ON CONFLICT (payment_id) DO UPDATE SET
      status = EXCLUDED.status, submitted_at = EXCLUDED.submitted_at,
      reviewer_user_id = EXCLUDED.reviewer_user_id, reviewed_at = EXCLUDED.reviewed_at,
      rejection_reason = NULL, resubmission_allowed = true, resubmission_count = 0,
      updated_at = now()
  `;
  // The money facts a real verification writes alongside the proof. Without them the ledger says
  // `pending` while the proof says `verified`, and the candidate view would correctly report the
  // weaker "menunggu verifikasi", leaving `paid` unreachable, which is the whole point of this
  // row. ON CONFLICT DO NOTHING because these are append-only and the reset does not remove them.
  await sql`
    INSERT INTO finance_payment_events (id, payment_id, event_type, occurred_at, amount,
      currency, actor_type, actor_user_id, idempotency_key)
    VALUES ('seed-payev-d-settled', 'seed-pay-d-settled', 'succeeded', ${h(-44)}, 150000,
      'IDR', 'user', 'seed-user-rec-elev', 'mn:verified:seed-proof-d-settled:0')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO finance_fee_accruals (id, payment_id, owing_institution_id, entry_type, currency,
      amount, fee_rule_id, fee_basis_points, fee_flat_amount, gross_amount)
    VALUES ('seed-accrual-d-settled', 'seed-pay-d-settled', 'seed-inst-a', 'accrued', 'IDR',
      3750, 'seed-feerule-default', 250, 0, 150000)
    ON CONFLICT (id) DO NOTHING
  `;

  // A SECOND ACCRUAL PRICED UNDER A SUPERSEDED RULE. Without it the fee statement renders one
  // line at one rate, and "shows today's rate against a historical accrual" (the failure DEC-0171
  // exists to prevent, and the one that starts a billing dispute) cannot be observed at all. The
  // rule it names is retired (effective_to in the past), so a statement that joined the rule table
  // instead of reading the accrual's own snapshot would show 2,5% here and be wrong.
  await sql`
    INSERT INTO finance_fee_rules (id, institution_id, currency, basis_points, flat_amount,
      effective_from, effective_to)
    VALUES ('seed-feerule-retired', 'seed-inst-a', 'IDR', 500, 0, ${d(-365)}, ${d(-120)})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO finance_fee_accruals (id, payment_id, owing_institution_id, entry_type, currency,
      amount, fee_rule_id, fee_basis_points, fee_flat_amount, gross_amount, created_at)
    VALUES ('seed-accrual-historic', 'seed-pay-a', 'seed-inst-a', 'accrued', 'IDR',
      7500, 'seed-feerule-retired', 500, 0, 150000, ${d(-150)})
    ON CONFLICT (id) DO NOTHING
  `;

  // A REVERSED ACCRUAL, because without one the fee statement's browser check measures a state
  // that does not exist. The signed-amount handling is the only arithmetic on this page that can
  // be wrong in the direction that overstates a receivable, and every fixture here was an
  // `accrued` row, so the check passed over a code path it had never rendered. Columns mirror
  // `recordFeeAccrualReversal` exactly: the exact negation, and the accrual's OWN rate snapshot
  // rather than the rule's current one. Verification itself is not walked back: reversing the fee
  // and unwinding the proof are separate acts, and only the first has a primitive today.
  await sql`
    INSERT INTO finance_fee_accruals (id, payment_id, owing_institution_id, entry_type, currency,
      amount, fee_rule_id, fee_basis_points, fee_flat_amount, gross_amount, reason)
    VALUES ('seed-accrual-d-reversed', 'seed-pay-d-settled', 'seed-inst-a', 'reversed', 'IDR',
      -3750, 'seed-feerule-default', 250, 0, 150000,
      'Dana ditarik kembali oleh bank setelah verifikasi')
    ON CONFLICT (id) DO NOTHING
  `;

  // R2's record: the rate this institution was shown and accepted before it charged anybody. The
  // snapshot is what makes the receivable defensible, so the statement has to be able to show it.
  await sql`
    INSERT INTO finance_fee_disclosure_acknowledgements (id, competition_id, institution_id,
      acknowledged_by_user_id, fee_rule_id, fee_basis_points, fee_flat_amount, fee_amount,
      fee_currency, acknowledged_at)
    VALUES ('seed-feeack-paid', 'seed-comp-paid', 'seed-inst-a', 'seed-user-rec-elev',
      'seed-feerule-default', 250, 0, 150000, 'IDR', ${d(-30)})
    ON CONFLICT (id) DO NOTHING
  `;

  // The rejection's own history row. Written at CLOSE, which is what keeps the table append-only.
  await sql`
    INSERT INTO finance_manual_payment_proof_attempts (id, proof_id, payment_id, competition_id,
      attempt_number, submitted_by_user_id, r2_key, original_file_name, file_size_bytes,
      content_type, submitted_at, verdict, verdict_reason, reviewer_user_id, reviewed_at)
    VALUES ('seed-proofatt-c-0', 'seed-proof-c', 'seed-pay-c', 'seed-comp-paid', 0,
      'seed-user-cand-c', 'payment-proofs/seed-comp-paid/seed-pay-c/seed-bukti-c',
      'bukti-transfer-cindy.jpg', 96256, 'image/jpeg', ${h(-30)}, 'rejected',
      'Nominal transfer tidak sesuai, tertera Rp100.000, seharusnya Rp150.000.',
      'seed-user-rec-elev', ${h(-20)})
    ON CONFLICT (proof_id, attempt_number) DO NOTHING
  `;

  // A RESUBMITTED proof, and the closed attempt behind it. This is the state the finance_ops
  // dispute view exists for: the live row shows attempt two, and attempt one (the rejection the
  // candidate is actually disputing) survives only in the history table (migration 0059). A seed
  // with no resubmission anywhere would let that view ship without ever rendering a history row.
  await sql`
    UPDATE finance_manual_payment_proofs
    SET status = 'pending_review', resubmission_count = 1, reviewer_user_id = NULL,
        reviewed_at = NULL, rejection_reason = NULL,
        original_file_name = 'bukti-transfer-bela-revisi.jpg', submitted_at = ${h(-6)},
        updated_at = now()
    WHERE id = 'seed-proof-b'
  `;
  await sql`
    INSERT INTO finance_manual_payment_proof_attempts (id, proof_id, payment_id, competition_id,
      attempt_number, submitted_by_user_id, r2_key, original_file_name, file_size_bytes,
      content_type, submitted_at, verdict, verdict_reason, reviewer_user_id, reviewed_at)
    VALUES ('seed-proofatt-b-0', 'seed-proof-b', 'seed-pay-b', 'seed-comp-paid', 0,
      'seed-user-cand-b', 'payment-proofs/seed-comp-paid/seed-pay-b/seed-bukti-b-attempt0',
      'bukti-transfer-bela.jpg', 184320, 'image/jpeg', ${h(-28)}, 'rejected',
      'Tanggal transfer tidak terbaca pada bukti.', 'seed-user-rec-elev', ${h(-24)})
    ON CONFLICT (proof_id, attempt_number) DO NOTHING
  `;
};

/**
 * Clears what an automated pass writes into this lane, so the lane is re-runnable.
 *
 * Moved here WITH the rows it clears. A teardown that outlives its writes starts deleting rows
 * nobody creates, and reads as coverage it no longer has.
 *
 * THE ATTEMPT ROWS GO FIRST, because their foreign key is ON DELETE NO ACTION, deliberately, since
 * an attempt history that vanishes with the row it describes is not a history. Without this delete
 * the whole pipeline becomes one-shot the moment any pass DECIDES a proof: the proof delete below
 * fails on the constraint and the seed cannot reset anything after it.
 *
 * NOTHING IS DELETED FROM finance_payment_events OR finance_fee_accruals, and that is not an
 * omission. DEC-0133 makes those append-only: a seed that un-records a money fact is doing the one
 * thing the ledger exists to prevent, and the append-only source scan refuses it. A future pass
 * that VERIFIES a seeded proof must create its own payment for that purpose rather than expect this
 * script to reverse the ledger.
 */
export const resetManualPaymentLaneScratch = async (sql: Sql): Promise<void> => {
  await sql`
    DELETE FROM finance_manual_payment_proof_attempts
    WHERE proof_id IN (
      SELECT id FROM finance_manual_payment_proofs
      WHERE payment_id LIKE 'seed-pay-%' AND id NOT LIKE 'seed-proof-%'
    )
  `;
  await sql`
    DELETE FROM finance_manual_payment_proofs
    WHERE payment_id LIKE 'seed-pay-%' AND id NOT LIKE 'seed-proof-%'
  `;
};

/**
 * The finance tables this module is the only writer of, DERIVED FROM THE SCHEMA.
 *
 * Every table the schema names `finance_*`, plus the institution's payment instructions, which are
 * the payee's bank details and belong to the money domain under a different prefix. A hand-typed
 * list preceded this and was complete on the day it was written; the next finance table would have
 * been the one it missed. Deriving it means a table added to the schema is in the set before anyone
 * remembers this file exists, and the census test checks the one thing derivation cannot: that the
 * set reaches every table this lane actually writes.
 */
const PAYMENT_INSTRUCTION_TABLE = getTableName(institutionPaymentInstructions);

const isFinanceLaneTable = (table: string): boolean =>
  table.startsWith("finance_") || table === PAYMENT_INSTRUCTION_TABLE;

export const FINANCE_LANE_TABLES: readonly string[] = Object.freeze(
  (Object.values(schema) as unknown[])
    .filter((value): value is Table => is(value, Table))
    .map((table) => getTableName(table))
    .filter(isFinanceLaneTable)
    .sort(),
);

/** One table's rows, as a count and a checksum over their content. */
export type FinanceTableSnapshot = Readonly<{ count: number; checksum: string }>;

export type FinanceSnapshot = Readonly<Record<string, FinanceTableSnapshot>>;

/**
 * What each finance table holds right now: how many rows, and a digest of what is in them.
 *
 * THE CHECKSUM IS WHAT MAKES THIS A CONTENT CHECK. A count alone cannot see an UPDATE, and it
 * cannot see an upsert that lands on an existing row, the exact shape the lane itself used on
 * `finance_payments` until the append-only pin learned to recognise it. The digest is over every
 * row's text, ordered by that text, so it is the same for the same rows however they were written.
 *
 * Queried by name from the derived set rather than as one hand-written UNION, so a table added to
 * the schema is measured without anyone remembering to add it twice.
 */
export const snapshotFinanceTables = async (sql: Sql): Promise<FinanceSnapshot> => {
  const snapshot: Record<string, FinanceTableSnapshot> = {};

  for (const table of FINANCE_LANE_TABLES) {
    const [row] = await sql<{ count: number; checksum: string }[]>`
      SELECT
        count(*)::int AS count,
        coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '') AS checksum
      FROM ${sql(table)} AS t
    `;

    snapshot[table] = { count: row?.count ?? 0, checksum: row?.checksum ?? "" };
  }

  return snapshot;
};

const describeChange = (
  table: string,
  before?: FinanceTableSnapshot,
  after?: FinanceTableSnapshot,
) =>
  before?.count === after?.count
    ? `${table} (${before?.count ?? 0} rows, content changed)`
    : `${table} (${before?.count ?? 0} → ${after?.count ?? 0} rows)`;

/**
 * Refuses if the matrix seed changed any finance table while it ran.
 *
 * A DIFFERENCE, NOT A TOTAL, and the distinction is the whole assertion. "No finance table holds a
 * row" is a claim about the DATABASE, and it is false on any machine where the lane has ever been
 * seeded: those rows are append-only and cannot be removed, so a total-based check would fail
 * forever on a developer's machine for something the matrix seed did not do. It was written that
 * way first and failed on exactly that.
 *
 * What is actually being claimed is narrower and is a claim about THIS SEED: that it wrote nothing.
 * Comparing the snapshot before and after says precisely that, on any starting state, and it is
 * what goes red if a finance write returns to the matrix seed, which is the property this split
 * exists to keep. Compared on content and not only on count, so an UPDATE or a row-replacing upsert
 * is as visible as an INSERT.
 */
export const assertMatrixSeedWroteNoFinanceRows = (
  before: FinanceSnapshot,
  after: FinanceSnapshot,
): void => {
  const changed = FINANCE_LANE_TABLES.filter(
    (table) =>
      before[table]?.count !== after[table]?.count ||
      before[table]?.checksum !== after[table]?.checksum,
  ).map((table) => describeChange(table, before[table], after[table]));

  if (changed.length > 0) {
    throw new Error(
      `the matrix seed changed ${changed.length} finance table(s) while it ran: ${changed.join(", ")}.\n` +
        "The money lane is Phase 4's and lives in scripts/seed/manual-payment-lane.ts, which this " +
        "seed does not call. DEC-0133 makes the payment, event and accrual tables append-only, so " +
        "rows written here cannot be removed afterwards, and migration 0058 refuses to apply " +
        "against a non-empty finance_payments (DEC-0165).",
    );
  }
};
