// @vitest-environment node
//
// createFeeRule resolves its acting account from the database inside the one transaction that
// writes the rule and its audit row (LAUNCH-D136). The rule's own arithmetic is covered by the
// fee-computation tests; this file measures who may write one, and what a refusal leaves behind.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { createFeeRule, type CreateFeeRuleInput } from "@/server/finance/fee-rule-service";
import type { Database } from "@/server/db/client";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE } from "@/server/institution-verification/operator-institution-conflict";
import {
  CONFLICTED_RELATIONSHIP_CASES,
  NO_INSTITUTION_RELATIONSHIP_READS,
  invalidOperatorActorCases,
  makeSequencedSelect,
  operatorActorRow,
  type SelectRows,
} from "@/server/testing/operator-writer-stubs";

const OPS_ACTOR_ID = "ops_1";

const globalRule: CreateFeeRuleInput = {
  institutionId: null,
  currency: "IDR",
  basisPoints: 250,
  flatAmount: 0,
  minimumFeeAmount: null,
  maximumFeeAmount: null,
  effectiveFrom: new Date("2026-09-01T00:00:00Z"),
  effectiveTo: null,
};

const institutionRule: CreateFeeRuleInput = { ...globalRule, institutionId: "inst_1" };

// Reads in call order: the acting account, the institution's existence (institution-scoped rules
// only), then the four reads of the institution-relationship check.
const makeDb = (
  input: CreateFeeRuleInput,
  extras: {
    actorRow?: SelectRows[number] | null;
    institutionRows?: SelectRows;
    relationshipReads?: SelectRows[];
  } = {},
) => {
  const actorRow = extras.actorRow === undefined ? operatorActorRow(OPS_ACTOR_ID) : extras.actorRow;
  const reads: SelectRows[] = [actorRow ? [actorRow] : []];
  if (input.institutionId !== null) {
    reads.push(extras.institutionRows ?? [{ id: input.institutionId }]);
    reads.push(...(extras.relationshipReads ?? NO_INSTITUTION_RELATIONSHIP_READS));
  }

  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: makeSequencedSelect(reads),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Object.assign(Promise.resolve(undefined), {
          returning: vi.fn().mockResolvedValue([{ id: "rule_1", ...values }]),
        });
      },
    })),
  };
  const db = {
    select: vi.fn(),
    transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
  } as unknown as Database;

  return { db, tx, inserted };
};

const auditRows = (inserted: Array<Record<string, unknown>>) =>
  inserted.filter((row) => "eventType" in row);

describe("createFeeRule operator integrity", () => {
  it.each(invalidOperatorActorCases(OPS_ACTOR_ID))(
    "refuses a $label actor before any other read, and writes nothing",
    async ({ row, code }) => {
      const { db, inserted } = makeDb(institutionRule, { actorRow: row });
      const refusal = await createFeeRule(OPS_ACTOR_ID, institutionRule, db).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({ code, status: 403 });
      expect(inserted).toHaveLength(0);
    },
  );

  it.each(CONFLICTED_RELATIONSHIP_CASES)(
    "refuses a rule for an institution the operator has a $arm relationship to",
    async ({ reads }) => {
      const { db, inserted } = makeDb(institutionRule, { relationshipReads: reads });
      const refusal = await createFeeRule(OPS_ACTOR_ID, institutionRule, db).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({
        code: "operator_actor_conflicted",
        status: 403,
        message: OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
      });
      expect(inserted).toHaveLength(0);
    },
  );

  it("404s an institution that does not exist, and writes nothing", async () => {
    const { db, inserted } = makeDb(institutionRule, { institutionRows: [] });
    await expect(createFeeRule(OPS_ACTOR_ID, institutionRule, db)).rejects.toMatchObject({
      code: "fee_rule_institution_not_found",
      status: 404,
    });
    expect(inserted).toHaveLength(0);
  });

  it("validates the terms before any database work", async () => {
    const { db, tx } = makeDb({ ...globalRule, currency: "XXX" });
    await expect(
      createFeeRule(OPS_ACTOR_ID, { ...globalRule, currency: "XXX" }, db),
    ).rejects.toMatchObject({ code: "fee_rule_currency_unsupported" });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });

  it("records a global rule without running the institution check, naming the database actor", async () => {
    const { db, inserted } = makeDb(globalRule, {
      actorRow: operatorActorRow("database-actor"),
    });
    await createFeeRule("claimed-actor", globalRule, db);

    const audits = auditRows(inserted);
    expect(audits).toHaveLength(1);
    // The actor is a placeholder target for a rule that names no institution, not a self-action.
    expect(audits[0]).toMatchObject({
      actorUserId: "database-actor",
      targetUserId: "database-actor",
      targetInstitutionId: null,
      eventType: "finance_fee_rule_created",
    });
  });

  it("records an institution-scoped rule against its institution, naming the database actor", async () => {
    const { db, inserted } = makeDb(institutionRule, {
      actorRow: operatorActorRow("database-actor"),
    });
    await createFeeRule("claimed-actor", institutionRule, db);

    const audits = auditRows(inserted);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: "database-actor",
      targetInstitutionId: "inst_1",
    });
  });
});
