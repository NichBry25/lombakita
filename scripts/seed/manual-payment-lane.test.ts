/**
 * The lane's finance-table set and the matrix seed's post-condition over it.
 *
 * The comparison is exercised on hand-built snapshots so what it can see is pinned independently
 * of what the database holds. The case that matters is the third one: same count, different
 * content, which a count-only comparison reports as "nothing written".
 */

import { describe, expect, it } from "vitest";
import {
  FINANCE_LANE_TABLES,
  type FinanceSnapshot,
  assertMatrixSeedWroteNoFinanceRows,
} from "./manual-payment-lane";

const snapshotWhere = (overrides: Partial<Record<string, { count: number; checksum: string }>>) =>
  Object.fromEntries(
    FINANCE_LANE_TABLES.map((table) => [table, overrides[table] ?? { count: 1, checksum: "a" }]),
  ) as FinanceSnapshot;

describe("FINANCE_LANE_TABLES", () => {
  it("is derived from the schema and includes the instructions table under its own prefix", () => {
    expect(FINANCE_LANE_TABLES).toContain("finance_payments");
    expect(FINANCE_LANE_TABLES).toContain("institution_payment_instructions");
    expect(FINANCE_LANE_TABLES.every((table) => typeof table === "string")).toBe(true);
  });

  it("is sorted and free of duplicates, so two derivations compare equal", () => {
    expect([...FINANCE_LANE_TABLES]).toEqual([...new Set(FINANCE_LANE_TABLES)].sort());
  });
});

describe("assertMatrixSeedWroteNoFinanceRows", () => {
  it("passes when nothing changed", () => {
    expect(() =>
      assertMatrixSeedWroteNoFinanceRows(snapshotWhere({}), snapshotWhere({})),
    ).not.toThrow();
  });

  it("refuses a table that gained rows", () => {
    const after = snapshotWhere({ finance_payments: { count: 2, checksum: "b" } });

    expect(() => assertMatrixSeedWroteNoFinanceRows(snapshotWhere({}), after)).toThrow(
      /finance_payments \(1 → 2 rows\)/,
    );
  });

  // The shape a count cannot see: an UPDATE, or an upsert landing on an existing row. The lane
  // itself issued exactly this against finance_payments until the append-only pin caught it.
  it("refuses a table whose content changed at the same count", () => {
    const after = snapshotWhere({ finance_fee_rules: { count: 1, checksum: "different" } });

    expect(() => assertMatrixSeedWroteNoFinanceRows(snapshotWhere({}), after)).toThrow(
      /finance_fee_rules \(1 rows, content changed\)/,
    );
  });
});
