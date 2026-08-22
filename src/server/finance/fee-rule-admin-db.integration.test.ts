// @vitest-environment node
//
// The fee-rule admin write path, against a real Postgres.
//
// What a mocked database cannot reach here: `platform_ops_audit_logs_target_present_chk`. A GLOBAL
// fee rule names no institution, so the audit row it writes has a NULL target_institution_id, and
// whether that row is accepted depends on a CHECK constraint the unit suite does not evaluate. A
// mocked `tx.insert` accepts any object, so a fee-rule surface that silently failed to audit, or
// that wrote an audit row the database refuses, would look identical to a correct one.
//
// Every test runs inside a transaction that is ALWAYS rolled back. Skipped when no DATABASE_URL is
// reachable, so a developer without a local Postgres is not blocked.

import { afterAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, and, eq } from "drizzle-orm";
import postgres from "postgres";
import { financeFeeRules, institutions, platformOpsAuditLogs, users } from "@/server/db/schema";
import { createFeeRule, listFeeRules, requireFeeRuleInForce } from "@/server/finance/fee-rule-service";
import type { Database } from "@/server/db/client";

const DATABASE_URL = TEST_DATABASE_URL;
const EFFECTIVE_FROM = new Date("2026-09-01T00:00:00.000Z");

const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

const seedOperator = async (tx: Tx): Promise<string> => {
  const suffix = uniqueSuffix();
  const [operator] = await tx
    .insert(users)
    .values({
      email: `ops_${suffix}@example.test`,
      username: `ops_${suffix}`,
      // users_one_verified_role_chk requires at least one verified role.
      candidateVerifiedAt: EFFECTIVE_FROM,
    })
    .returning({ id: users.id });

  if (!operator) throw new Error("operator seed failed");
  return operator.id;
};

const seedInstitution = async (tx: Tx): Promise<string> => {
  const [institution] = await tx
    .insert(institutions)
    .values({ slug: `fee-rule-inst-${uniqueSuffix()}`, institutionType: "personal" })
    .returning({ id: institutions.id });

  if (!institution) throw new Error("institution seed failed");
  return institution.id;
};

const countFeeRules = async (tx: Tx): Promise<number> =>
  (await tx.select({ id: financeFeeRules.id }).from(financeFeeRules)).length;

const baseInput = {
  institutionId: null as string | null,
  currency: "IDR",
  basisPoints: 250,
  flatAmount: 0,
  minimumFeeAmount: null,
  maximumFeeAmount: null,
  effectiveFrom: EFFECTIVE_FROM,
  effectiveTo: null,
};

describe.skipIf(skipWithoutDatabase)("fee-rule admin writes (real database)", () => {
  it("records a GLOBAL rule and an audit row the target_present CHECK accepts", async () => {
    // The constraint this file exists for. A global rule has no institution, so the audit row's
    // target_institution_id is NULL and only target_user_id carries it.
    await inRollback(async (tx) => {
      const actorUserId = await seedOperator(tx);

      const rule = await createFeeRule(actorUserId, baseInput, tx as unknown as Database);

      expect(rule.institutionId).toBeNull();

      const audits = await tx
        .select()
        .from(platformOpsAuditLogs)
        .where(
          and(
            eq(platformOpsAuditLogs.actorUserId, actorUserId),
            eq(platformOpsAuditLogs.eventType, "finance_fee_rule_created"),
          ),
        );

      expect(audits).toHaveLength(1);
      expect(audits[0]?.targetUserId).toBe(actorUserId);
      expect(audits[0]?.targetInstitutionId).toBeNull();
      expect((audits[0]?.metadata as { feeRuleId?: string })?.feeRuleId).toBe(rule.id);
      expect((audits[0]?.metadata as { scope?: string })?.scope).toBe("global");
    });
  });

  it("records an institution-scoped rule with the institution on the audit row", async () => {
    await inRollback(async (tx) => {
      const actorUserId = await seedOperator(tx);
      const institutionId = await seedInstitution(tx);

      const rule = await createFeeRule(
        actorUserId,
        { ...baseInput, institutionId },
        tx as unknown as Database,
      );

      expect(rule.institutionId).toBe(institutionId);

      const [audit] = await tx
        .select()
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.actorUserId, actorUserId));

      expect(audit?.targetInstitutionId).toBe(institutionId);
      expect((audit?.metadata as { scope?: string })?.scope).toBe("institution");
    });
  });

  it("REFUSES a rule whose clamp resolves to the full gross, writing neither rule nor audit", async () => {
    await inRollback(async (tx) => {
      const actorUserId = await seedOperator(tx);
      const rulesBefore = await countFeeRules(tx);

      await expect(
        createFeeRule(
          actorUserId,
          { ...baseInput, basisPoints: 10_000 },
          tx as unknown as Database,
        ),
      ).rejects.toThrow(/entire payment/i);

      // The refusal must precede both writes. An audit row for a rule that was never stored would
      // describe pricing that does not exist.
      //
      // Counted relative to what was already there rather than asserting the table is empty: this
      // suite must not depend on a clean database to be meaningful.
      const rulesAfter = await countFeeRules(tx);
      const audits = await tx
        .select()
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.actorUserId, actorUserId));

      expect(rulesAfter).toBe(rulesBefore);
      expect(audits).toHaveLength(0);
    });
  });

  it("refuses an unknown institution rather than recording an unattributable rule", async () => {
    await inRollback(async (tx) => {
      const actorUserId = await seedOperator(tx);
      const rulesBefore = await countFeeRules(tx);

      await expect(
        createFeeRule(
          actorUserId,
          { ...baseInput, institutionId: "no-such-institution" },
          tx as unknown as Database,
        ),
      ).rejects.toThrow(/not found/i);

      expect(await countFeeRules(tx)).toBe(rulesBefore);
    });
  });

  it("refuses an end date at or before the start date", async () => {
    await inRollback(async (tx) => {
      const actorUserId = await seedOperator(tx);

      await expect(
        createFeeRule(
          actorUserId,
          { ...baseInput, effectiveTo: EFFECTIVE_FROM },
          tx as unknown as Database,
        ),
      ).rejects.toThrow(/after its start/i);
    });
  });

  it("REFUSES to resolve a rate when no rule is in force", async () => {
    await inRollback(async (tx) => {
      const institutionId = await seedInstitution(tx);

      // The fail-closed path against a real, genuinely empty table rather than a mocked empty
      // result. This is the state a fresh environment is in before anyone configures pricing.
      await expect(
        requireFeeRuleInForce(institutionId, new Date("2026-09-02T00:00:00.000Z"), tx as unknown as Database),
      ).rejects.toThrow(/no platform fee rule is in force/i);
    });
  });

  it("resolves the rule once one is in force, and lists it", async () => {
    await inRollback(async (tx) => {
      const actorUserId = await seedOperator(tx);
      const institutionId = await seedInstitution(tx);
      const listedBefore = await listFeeRules(tx as unknown as Database);

      const created = await createFeeRule(actorUserId, baseInput, tx as unknown as Database);

      const resolved = await requireFeeRuleInForce(
        institutionId,
        new Date("2026-09-02T00:00:00.000Z"),
        tx as unknown as Database,
      );

      expect(resolved.basisPoints).toBe(250);

      const listedAfter = await listFeeRules(tx as unknown as Database);

      expect(listedAfter).toHaveLength(listedBefore.length + 1);
      expect(listedAfter.some((entry) => entry.id === created.id)).toBe(true);
    });
  });
});
