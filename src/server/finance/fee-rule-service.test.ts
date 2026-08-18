// @vitest-environment node
//
// Fail-closed fee resolution. `resolveFeeRule` itself is exercised against a real database in
// finance-schema-db.integration.test.ts — its ordering rules live in SQL and a mock cannot assert
// them. What is tested here is the decision made ABOVE that query: what happens when nothing is in
// force, which is a branch rather than a query and is the one a paid path must never fall through.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  FeeRuleError,
  requireFeeRuleInForce,
  toFeeRuleTerms,
} from "@/server/finance/fee-rule-service";
import type { Database } from "@/server/db/client";
import type { FinanceFeeRuleRecord } from "@/server/db/schema";

const AT = new Date("2026-08-16T00:00:00Z");

// A db whose select chain resolves to `rows`. Enough for resolveFeeRule, whose result is all this
// helper branches on.
const dbReturning = (rows: FinanceFeeRuleRecord[]): Database => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };

  return { select: () => chain } as unknown as Database;
};

const rule = (overrides: Partial<FinanceFeeRuleRecord> = {}): FinanceFeeRuleRecord =>
  ({
    id: "rule-1",
    institutionId: null,
    currency: "IDR",
    basisPoints: 250,
    flatAmount: 0,
    minimumFeeAmount: null,
    maximumFeeAmount: null,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }) as FinanceFeeRuleRecord;

describe("requireFeeRuleInForce", () => {
  it("returns the rule in force", async () => {
    const inForce = rule();

    await expect(requireFeeRuleInForce("inst-1", AT, dbReturning([inForce]))).resolves.toBe(
      inForce,
    );
  });

  it("REFUSES when no rule is in force, rather than resolving to a zero fee", async () => {
    // The whole point. A helper that returned zero-rate terms here would price a payment at a 0%
    // platform fee, record a coherent split, accrue nothing, and pass every downstream assertion —
    // a silently free transaction is unrecoverable in an append-only ledger, a refusal is not.
    await expect(requireFeeRuleInForce("inst-1", AT, dbReturning([]))).rejects.toThrow(FeeRuleError);
  });

  it("names the refusal fee_rule_not_in_force so a caller can surface it", async () => {
    const error = await requireFeeRuleInForce("inst-1", AT, dbReturning([])).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(FeeRuleError);
    expect((error as FeeRuleError).code).toBe("fee_rule_not_in_force");
  });
});

describe("toFeeRuleTerms", () => {
  it("carries the stored rule's terms through unchanged", () => {
    expect(toFeeRuleTerms(rule({ basisPoints: 300, flatAmount: 2_500 }))).toEqual({
      basisPoints: 300,
      flatAmount: 2_500,
      minimumFeeAmount: null,
      maximumFeeAmount: null,
      currency: "IDR",
    });
  });

  it("refuses a rule denominated in a currency this system cannot interpret", () => {
    expect(() => toFeeRuleTerms(rule({ currency: "USD" }))).toThrow(FeeRuleError);
  });
});
