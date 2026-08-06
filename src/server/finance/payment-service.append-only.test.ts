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

const financeSourceFiles = (): string[] =>
  readdirSync(FINANCE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .map((name) => resolve(FINANCE_DIR, name));

/**
 * Every non-test source file under `src/`.
 *
 * The mutation scan below walks ALL of these, not just the finance directory: a mutation written
 * from a future `src/server/checkout/` or straight out of a route handler is exactly as fatal to
 * the append-only guarantee as one written here, and scanning one directory would have declared it
 * safe.
 */
const allSourceFiles = (dir: string = SRC_DIR): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return allSourceFiles(path);
    if (!/\.(ts|tsx)$/.test(name) || name.includes(".test.")) return [];
    return [path];
  });

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

    expect(exported).toEqual(["FeeRuleError", "resolveFeeRule", "toFeeRuleTerms"]);
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
    const viaBuilder = /\.\s*(update|delete)\s*\(\s*finance[A-Za-z]*/;
    const viaRawSql = /\b(update\s+finance_|delete\s+from\s+finance_)/i;

    const offending: string[] = [];

    for (const file of allSourceFiles()) {
      const source = readFileSync(file, "utf8");
      // Newlines collapsed so `db\n  .update(financePayments)` cannot straddle the line boundary
      // and escape a line-oriented scan.
      const flattened = source.replace(/\s*\n\s*/g, " ");
      if (viaBuilder.test(flattened) || viaRawSql.test(flattened)) {
        offending.push(file.replace(`${process.cwd()}/`, ""));
      }
    }

    expect(offending, "a finance row is mutated — the ledger is append-only").toEqual([]);
  });

  it("scans a realistic slice of the tree, so neither scan can silently match nothing", () => {
    // A scan that matched zero files would pass forever. These are the tripwires.
    expect(financeSourceFiles().length).toBeGreaterThanOrEqual(2);
    expect(allSourceFiles().length).toBeGreaterThanOrEqual(200);
    expect(allSourceFiles()).toEqual(expect.arrayContaining(financeSourceFiles()));
  });
});
