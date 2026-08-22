import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/fee-rule-service");

import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  financeFeeRules,
  institutions,
  platformOpsAuditLogs,
  type FinanceFeeRuleRecord,
} from "@/server/db/schema";
import {
  computePlatformFee,
  FeeComputationError,
  findFeeRuleRejection,
  type FeeRuleTerms,
} from "@/lib/finance/fee";
import { isSupportedCurrency } from "@/lib/finance/money";

// The audit event a fee-rule write records. A literal rather than a shared enum: the audit table's
// event_type is free text, and the MFA events are the only ones with a shared constant today.
const FEE_RULE_CREATED_EVENT = "finance_fee_rule_created";

export type FeeRuleErrorCode =
  | "fee_rule_currency_unsupported"
  | "fee_rule_not_in_force"
  | "fee_rule_takes_entire_payment"
  | "fee_rule_terms_invalid"
  | "fee_rule_effective_window_invalid"
  | "fee_rule_institution_not_found";

export class FeeRuleError extends Error {
  constructor(
    public readonly code: FeeRuleErrorCode,
    message: string,
    public readonly status: number = 422,
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
 * The fee rule in force for `institutionId` at `at`, or a refusal when there is none.
 *
 * `resolveFeeRule` returning null is a real state (no commercial rate is seeded) and a caller that
 * is about to PRICE something cannot proceed through it. The failure mode this exists to prevent is
 * quiet rather than loud: treating "no rule" as zero would compute a valid-looking payment carrying
 * a zero platform fee, record it as a completed split, and accrue nothing, with every downstream
 * assertion passing. A refusal is recoverable by configuring a rule; a ledger of silently free
 * transactions is not.
 *
 * Any path that turns money on uses this. `resolveFeeRule` stays available for paths that can
 * legitimately observe the absence, such as a read-only preview asking "is a rate configured yet".
 */
export const requireFeeRuleInForce = async (
  institutionId: string,
  at: Date,
  db: Database = getDb(),
): Promise<FinanceFeeRuleRecord> => {
  const rule = await resolveFeeRule(institutionId, at, db);

  if (!rule) {
    throw new FeeRuleError(
      "fee_rule_not_in_force",
      "No platform fee rule is in force. Paid registration cannot be enabled until one is configured",
    );
  }

  return rule;
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

export type CreateFeeRuleInput = {
  // NULL is the platform-wide default rule, which names no institution.
  institutionId: string | null;
  currency: string;
  basisPoints: number;
  flatAmount: number;
  minimumFeeAmount: number | null;
  maximumFeeAmount: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

const assertStorableTerms = (input: CreateFeeRuleInput): FeeRuleTerms => {
  if (!isSupportedCurrency(input.currency)) {
    throw new FeeRuleError(
      "fee_rule_currency_unsupported",
      `Currency ${input.currency} is not supported`,
    );
  }

  const terms: FeeRuleTerms = {
    basisPoints: input.basisPoints,
    flatAmount: input.flatAmount,
    minimumFeeAmount: input.minimumFeeAmount,
    maximumFeeAmount: input.maximumFeeAmount,
    currency: input.currency,
  };

  // Arithmetic validity, borrowed from the computation itself rather than restated. A probe gross of
  // 0 exercises every bound and range check in `assertTerms` without depending on an amount.
  try {
    computePlatformFee(0, terms);
  } catch (error) {
    if (error instanceof FeeComputationError) {
      throw new FeeRuleError("fee_rule_terms_invalid", error.message);
    }
    throw error;
  }

  // Configuration validity, which arithmetic cannot detect: a 100% rate computes cleanly and clamps
  // to a zero institution net. Refused here because no later stage will.
  if (findFeeRuleRejection(terms) === "fee_rule_takes_entire_payment") {
    throw new FeeRuleError(
      "fee_rule_takes_entire_payment",
      "A rule at 100% takes the institution's entire payment and leaves it nothing on its own sale",
    );
  }

  return terms;
};

/**
 * Records a new fee rule, and one audit row naming who wrote it, in one transaction.
 *
 * THERE IS NO EDIT. Rules are effective-dated, so a rate change is a NEW rule taking over from a
 * date; editing one in place would rewrite the terms that already-recorded payments were priced
 * under. Payments snapshot their own figures, so an edit would not corrupt them. It would do
 * something worse, and leave the ledger disagreeing with the rule it names as its authority.
 *
 * A GLOBAL rule names no institution, but `platform_ops_audit_logs_target_present_chk` requires a
 * user or an institution on every row. `targetUserId` is therefore set to the ACTOR, following
 * `appendMfaAuditEvent`, with the rule id carried in metadata. The audit's subject is the operator
 * who changed platform pricing, which is the fact worth attributing.
 */
export const createFeeRule = async (
  actorUserId: string,
  input: CreateFeeRuleInput,
  db: Database = getDb(),
): Promise<FinanceFeeRuleRecord> => {
  assertStorableTerms(input);

  if (input.effectiveTo !== null && input.effectiveTo <= input.effectiveFrom) {
    throw new FeeRuleError(
      "fee_rule_effective_window_invalid",
      "A rule's end date must fall after its start date",
    );
  }

  if (input.institutionId !== null) {
    const [institution] = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.id, input.institutionId))
      .limit(1);

    if (!institution) {
      throw new FeeRuleError("fee_rule_institution_not_found", "Institution not found", 404);
    }
  }

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(financeFeeRules)
      .values({
        institutionId: input.institutionId,
        currency: input.currency,
        basisPoints: input.basisPoints,
        flatAmount: input.flatAmount,
        minimumFeeAmount: input.minimumFeeAmount,
        maximumFeeAmount: input.maximumFeeAmount,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
      })
      .returning();

    if (!created) {
      throw new FeeRuleError("fee_rule_terms_invalid", "Fee rule could not be recorded");
    }

    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      targetUserId: actorUserId,
      targetInstitutionId: input.institutionId,
      eventType: FEE_RULE_CREATED_EVENT,
      metadata: {
        feeRuleId: created.id,
        scope: input.institutionId === null ? "global" : "institution",
        currency: input.currency,
        basisPoints: input.basisPoints,
        flatAmount: input.flatAmount,
        minimumFeeAmount: input.minimumFeeAmount,
        maximumFeeAmount: input.maximumFeeAmount,
        effectiveFrom: input.effectiveFrom.toISOString(),
        effectiveTo: input.effectiveTo?.toISOString() ?? null,
      },
    });

    return created;
  });
};

export type FeeRuleListEntry = FinanceFeeRuleRecord & {
  institutionSlug: string | null;
};

/**
 * Every fee rule, newest effective window first, with the institution each names.
 *
 * Unscoped by design: this is the platform-wide pricing surface, reached only through the
 * `platform_ops` gate, and an operator setting a global rate has to see the institution-scoped rules
 * that will override it.
 */
export const listFeeRules = async (db: Database = getDb()): Promise<FeeRuleListEntry[]> => {
  const rows = await db
    .select({
      rule: financeFeeRules,
      institutionSlug: institutions.slug,
    })
    .from(financeFeeRules)
    .leftJoin(institutions, eq(institutions.id, financeFeeRules.institutionId))
    .orderBy(desc(financeFeeRules.effectiveFrom), desc(financeFeeRules.createdAt));

  return rows.map((row) => ({ ...row.rule, institutionSlug: row.institutionSlug }));
};
