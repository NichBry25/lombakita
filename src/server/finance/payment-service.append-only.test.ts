// @vitest-environment node
//
// The append-only guarantee (DEC-0133), asserted against the code rather than against a promise.
//
// The ledger's integrity does not rest on a database trigger — this codebase uses none — so what
// actually keeps `finance_payment_events` append-only is that no function anywhere can update or
// delete one. That is a property of the SOURCE, and this file is where it is checked. A future
// session that adds `updatePaymentEvent` fails here instead of shipping.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import * as paymentService from "@/server/finance/payment-service";
import * as feeRuleService from "@/server/finance/fee-rule-service";

const FINANCE_DIR = resolve(process.cwd(), "src/server/finance");
const SRC_DIR = resolve(process.cwd(), "src");
const SCRIPTS_DIR = resolve(process.cwd(), "scripts");

/**
 * Finance-domain tables that are deliberately MUTABLE, and why each one is.
 *
 * DEC-0133 makes the LEDGER append-only — `finance_payments`, `finance_payment_events`,
 * `finance_fee_accruals`. Those record what happened to money and must never move. It does not
 * make every table that happens to live in the finance domain immutable, and conflating the two
 * would force a real requirement to be dodged by giving a table a misleading name.
 *
 *   finance_manual_payment_proofs — a REVIEW ARTIFACT, not a money fact. Its status transitions
 *     (pending_review → verified / rejected → pending_review …) are the DEC-0115 revision loop, and
 *     each transition is an optimistic CAS. The money facts about the same payment live in the
 *     ledger tables and do not move when this row does.
 *
 * Both the camelCase identifier and the snake_case table name are listed, because the two scan
 * patterns match different spellings.
 */
const MUTABLE_FINANCE_TABLES = [
  "financeManualPaymentProofs",
  "finance_manual_payment_proofs",
] as const;

/**
 * Verification harnesses that seed and tear down their OWN rows against a scratch database.
 *
 * DEC-0133 constrains the application: nothing the product runs may move a recorded money fact.
 * A harness that inserts a fixture, races it, and deletes exactly what it inserted is not the
 * application and never runs against a real ledger. Pinned by exact path rather than by a
 * `scripts/` blanket, so a NEW script that mutates finance rows fails here and has to be argued in.
 */
const HARNESS_FILES = [
  "scripts/concurrency/finance-idempotency-races.ts",
  "scripts/finance/verify-payment-ledger.ts",
] as const;

/**
 * How a finance table can be named in raw SQL: bare, schema-qualified, quoted either way, and with
 * ONLY in front of it. Each spelling reaches the same rows, and a scan that knows one of them
 * reports the other three as clean.
 */
const RAW_TABLE = String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?finance_\w*`;

const MUTATION_PATTERNS = [
  // The query builder.
  new RegExp(String.raw`\.\s*(?:update|delete)\s*\(\s*finance[A-Za-z]*`, "g"),
  new RegExp(String.raw`\bupdate\s+${RAW_TABLE}`, "gi"),
  new RegExp(String.raw`\bdelete\s+from\s+${RAW_TABLE}`, "gi"),
  // TRUNCATE deletes every row in the table and contains neither `delete` nor `update`. It is the
  // single most destructive statement that could be aimed at the ledger, and the scan did not
  // mention it.
  new RegExp(String.raw`\btruncate\s+(?:table\s+)?${RAW_TABLE}`, "gi"),
];

/**
 * Every forbidden finance mutation in one source string.
 *
 * Extracted from the directory walk so it can be exercised against synthetic sources that DO
 * mutate the ledger — otherwise the exception list could silently neutralise the scan and every
 * test in this file would keep reporting green.
 */
const findForbiddenMutations = (source: string): string[] => {
  // Newlines collapsed so `db\n  .update(financePayments)` cannot straddle the line boundary and
  // escape a line-oriented scan.
  const flattened = source.replace(/\s*\n\s*/g, " ");

  const hits = MUTATION_PATTERNS.flatMap((pattern) => flattened.match(pattern) ?? []);

  return hits.filter((hit) => !MUTABLE_FINANCE_TABLES.some((allowed) => hit.includes(allowed)));
};

const financeSourceFiles = (): string[] =>
  readdirSync(FINANCE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .map((name) => resolve(FINANCE_DIR, name));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    if (!/\.(ts|tsx|mjs|js)$/.test(name) || name.includes(".test.")) return [];
    return [path];
  });

/**
 * Every non-test source file under `src/`.
 *
 * The mutation scan below walks ALL of these, not just the finance directory: a mutation written
 * from a future `src/server/checkout/` or straight out of a route handler is exactly as fatal to
 * the append-only guarantee as one written here, and scanning one directory would have declared it
 * safe.
 */
const allSourceFiles = (): string[] => walk(SRC_DIR);

const relative = (path: string): string => path.replace(`${process.cwd()}/`, "");

/**
 * Everything the scan covers: `src/` plus `scripts/`.
 *
 * `scripts/` was outside the scan entirely, which is the wrong side of the line to leave open — an
 * operational script pointed at a real database is the most plausible place a "just fix this one
 * row" ledger mutation actually gets written, and it would have passed silently.
 */
const allScannedFiles = (): string[] => [...allSourceFiles(), ...walk(SCRIPTS_DIR)];

describe("finance write surface", () => {
  it("exports exactly the intended payment functions — no update, no delete", () => {
    const exported = Object.keys(paymentService)
      .filter((name) => typeof (paymentService as Record<string, unknown>)[name] === "function")
      .sort();

    expect(exported).toEqual([
      "PaymentDatabaseError",
      "PaymentError",
      "appendPaymentEvent",
      "createPayment",
      "loadPaymentLedger",
    ]);
  });

  it("exports no mutating fee-rule function either", () => {
    const exported = Object.keys(feeRuleService)
      .filter((name) => typeof (feeRuleService as Record<string, unknown>)[name] === "function")
      .sort();

    // This list may grow with READS and with INSERTS; it may never grow with an update or a delete.
    //
    // `createFeeRule` belongs here on that reading. Fee rules are effective-dated, so a rate change
    // is a NEW ROW that takes over from a date — there is deliberately no edit-in-place, because
    // rewriting a rule's terms would leave already-recorded payments naming an authority whose
    // figures no longer match what they were priced under.
    expect(exported).toEqual([
      "FeeRuleError",
      "createFeeRule",
      "listFeeRules",
      "requireFeeRuleInForce",
      "resolveFeeRule",
      "toFeeRuleTerms",
    ]);
  });

  it("names no exported symbol that reads as a mutation of recorded finance rows", () => {
    const forbidden = /^(update|delete|remove|patch|edit|void|reverse|amend|set)[A-Z]/;

    for (const name of [...Object.keys(paymentService), ...Object.keys(feeRuleService)]) {
      expect(name, `${name} implies a mutation of an append-only record`).not.toMatch(forbidden);
    }
  });

  it("contains no update or delete against any finance table, anywhere in src/", () => {
    // The exported-name check above catches a helper someone bothered to name honestly. This
    // catches the actual statement, wherever it hides — inside a transaction, behind a private
    // helper, in a file added later, in a directory that does not exist yet.
    //
    // Two patterns, because a mutation has two shapes. The query builder is the obvious one; raw
    // SQL is the one a "just fix this one row" change actually reaches for, and it contains no
    // `.update(` at all.
    // The scan matches ANY `finance*` table by default and then subtracts the deliberate
    // exceptions below, rather than listing the append-only tables and matching only those. The
    // direction matters: a table added to the finance domain next year is caught automatically and
    // has to be argued INTO the exception list, instead of being silently outside a list nobody
    // remembered to extend.
    const offending: string[] = [];

    for (const file of allScannedFiles()) {
      const path = relative(file);
      if (HARNESS_FILES.includes(path as (typeof HARNESS_FILES)[number])) continue;
      if (findForbiddenMutations(readFileSync(file, "utf8")).length > 0) {
        offending.push(path);
      }
    }

    expect(offending, "a finance row is mutated — the ledger is append-only").toEqual([]);
  });

  it("pins the harness exception list so a new mutating script cannot slip in", () => {
    // Same discipline as the mutable-table list: this is the other place the guarantee can be
    // weakened, so adding an entry fails here first and has to be argued for.
    expect(HARNESS_FILES).toEqual([
      "scripts/concurrency/finance-idempotency-races.ts",
      "scripts/finance/verify-payment-ledger.ts",
    ]);

    // And each pinned file still exists, so a rename does not silently retire an exception while
    // leaving the real file unscanned under its new name.
    for (const path of HARNESS_FILES) {
      expect(allScannedFiles().map(relative), path).toContain(path);
    }
  });

  it("still catches a ledger mutation despite the exception list — the scan can fail", () => {
    // The exception list is subtracted from the scan's hits, so it is the one change that could
    // quietly turn this whole file into a test that passes forever. These synthetic sources prove
    // the matcher still fires on the tables that matter, and that it fires on the excepted spelling
    // ONLY for the excepted table.
    const mutatesLedger = [
      "await db.update(financePayments).set({ grossAmount: 0 });",
      "await db.delete(financePaymentEvents).where(eq(id, x));",
      "await db.update(financeFeeAccruals).set({ amount: 0 });",
      "await sql`update finance_payments set gross_amount = 0`;",
      "await sql`delete from finance_payment_events where id = 1`;",
      // Newline-straddling form, which a line-oriented scan would miss.
      "await db\n  .update(financePayments)\n  .set({});",
      // TRUNCATE empties the table and contains neither `update` nor `delete`.
      "await sql`truncate table finance_payments`;",
      "await sql`TRUNCATE finance_payment_events CASCADE`;",
      // Quoted, schema-qualified and ONLY spellings all reach the same rows.
      'await sql`update "finance_payments" set gross_amount = 0`;',
      "await sql`update public.finance_payments set gross_amount = 0`;",
      'await sql`delete from "public"."finance_payment_events" where id = 1`;',
      "await sql`update only finance_payments set gross_amount = 0`;",
      // Aliased forms, which read nothing like the bare statement.
      "await sql`update finance_payments AS p set gross_amount = 0 where p.id = 1`;",
      "await sql`delete from finance_fee_accruals a using x where a.id = x.id`;",
    ];

    for (const source of mutatesLedger) {
      expect(findForbiddenMutations(source), source).not.toEqual([]);
    }

    const allowed = [
      "await db.update(financeManualPaymentProofs).set({ status: 'verified' });",
      "await sql`update finance_manual_payment_proofs set status = 'verified'`;",
      "await db.select().from(financePayments);",
      "await db.insert(financeFeeAccruals).values(row);",
    ];

    for (const source of allowed) {
      expect(findForbiddenMutations(source), source).toEqual([]);
    }
  });

  it("pins the mutable-finance-table exception list so it cannot grow quietly", () => {
    // The exception list is the one place the append-only guarantee can be weakened, so it is
    // asserted exactly. Adding an entry is a deliberate act that fails this test first and has to
    // be argued for in review — which is the whole point of having the list rather than a naming
    // convention that a future table could accidentally satisfy.
    expect(MUTABLE_FINANCE_TABLES).toEqual([
      "financeManualPaymentProofs",
      "finance_manual_payment_proofs",
    ]);
  });

  it("scans a realistic slice of the tree, so neither scan can silently match nothing", () => {
    // A scan that matched zero files would pass forever. These are the tripwires.
    expect(financeSourceFiles().length).toBeGreaterThanOrEqual(2);
    expect(allSourceFiles().length).toBeGreaterThanOrEqual(200);
    expect(allSourceFiles()).toEqual(expect.arrayContaining(financeSourceFiles()));
  });
});
