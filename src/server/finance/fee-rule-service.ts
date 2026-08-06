import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/fee-rule-service");

import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { financeFeeRules, type FinanceFeeRuleRecord } from "@/server/db/schema";
import { type FeeRuleTerms } from "@/lib/finance/fee";
import { isSupportedCurrency } from "@/lib/finance/money";

export type FeeRuleErrorCode = "fee_rule_currency_unsupported";

export class FeeRuleError extends Error {
  constructor(
    public readonly code: FeeRuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FeeRuleError";
  }
}

/**
 * The fee rule in force for `institutionId` at instant `at`.
 *
 * An institution-scoped rule beats the global default (`institution_id IS NULL`) whenever both are
 * in force, and among rules of the same scope the one that started most recently wins. Overlapping
 * windows are therefore resolved rather than rejected: a rule written today to start tomorrow
 * simply takes over tomorrow, without anyone having to close the previous one first.
 *
 * Returns null when nothing is in force. That is a real state — no commercial rate is seeded — and
 * the caller decides what it means rather than being handed a fabricated default.
 */
export const resolveFeeRule = async (
  institutionId: string,
  at: Date,
  db: Database = getDb(),
): Promise<FinanceFeeRuleRecord | null> => {
  const [rule] = await db
    .select()
    .from(financeFeeRules)
    .where(
      and(
        or(eq(financeFeeRules.institutionId, institutionId), isNull(financeFeeRules.institutionId)),
        lte(financeFeeRules.effectiveFrom, at),
        or(isNull(financeFeeRules.effectiveTo), gt(financeFeeRules.effectiveTo, at)),
      ),
    )
    // Institution-scoped first (NULL institution_id sorts last), then most recently effective. Two
    // rules sharing an `effective_from` are broken by which was WRITTEN last — `id` is a random
    // uuid, so ordering on it alone would resolve a same-instant pair arbitrarily while reading as
    // if it picked the newer one.
    .orderBy(
      sql`case when ${financeFeeRules.institutionId} is null then 1 else 0 end`,
      desc(financeFeeRules.effectiveFrom),
      desc(financeFeeRules.createdAt),
      desc(financeFeeRules.id),
    )
    .limit(1);

  return rule ?? null;
};

/**
 * The pure fee terms carried by a stored rule.
 *
 * Refuses a rule whose currency this system does not support, rather than pricing a payment in a
 * currency nothing else in the stack can interpret.
 */
export const toFeeRuleTerms = (rule: FinanceFeeRuleRecord): FeeRuleTerms => {
  if (!isSupportedCurrency(rule.currency)) {
    throw new FeeRuleError(
      "fee_rule_currency_unsupported",
      `Fee rule ${rule.id} is denominated in unsupported currency ${rule.currency}`,
    );
  }

  return {
    basisPoints: rule.basisPoints,
    flatAmount: rule.flatAmount,
    minimumFeeAmount: rule.minimumFeeAmount,
    maximumFeeAmount: rule.maximumFeeAmount,
    currency: rule.currency,
  };
};
