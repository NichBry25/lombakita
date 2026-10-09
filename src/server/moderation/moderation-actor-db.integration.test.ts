// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  institutionMemberships,
  institutions,
  platformOpsAuditLogs,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import {
  reinstateInstitution,
  suspendInstitution,
  suspendUser,
  unsuspendUser,
} from "./moderation-service";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const NOW = new Date("2026-10-09T00:00:00.000Z");

afterAll(async () => {
  await client?.end();
});

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

const seedAccount = async (
  tx: Tx,
  role: "candidate" | "platform_ops",
  suspended = false,
): Promise<string> => {
  const id = randomUUID();
  await tx.insert(users).values({
    id,
    email: `moderation_${id}@example.test`,
    username: `moderation_${id}`,
    role,
    candidateVerifiedAt: NOW,
    suspendedAt: suspended ? NOW : null,
    suspensionReason: suspended ? "fixture" : null,
  });
  return id;
};

const actions = [
  {
    name: "suspendUser",
    service: suspendUser,
    user: true,
    suspended: false,
    event: "user.suspended",
  },
  {
    name: "unsuspendUser",
    service: unsuspendUser,
    user: true,
    suspended: true,
    event: "user.unsuspended",
  },
  {
    name: "suspendInstitution",
    service: suspendInstitution,
    user: false,
    suspended: false,
    event: "institution.suspended",
  },
  {
    name: "reinstateInstitution",
    service: reinstateInstitution,
    user: false,
    suspended: true,
    event: "institution.reinstated",
  },
];

const seedFixture = async (tx: Tx, action: (typeof actions)[number]) => {
  if (action.user) {
    return { targetId: await seedAccount(tx, "candidate", action.suspended) };
  }
  const ownerId = await seedAccount(tx, "candidate");
  const targetId = randomUUID();
  await tx.insert(institutions).values({
    id: targetId,
    displayName: "Moderation fixture",
    slug: `moderation-${targetId}`,
    institutionType: "company",
    suspendedAt: action.suspended ? NOW : null,
    suspensionReason: action.suspended ? "fixture" : null,
  });
  await tx.insert(institutionMemberships).values({
    institutionId: targetId,
    userId: ownerId,
    membershipRole: "institution_owner",
    status: "active",
  });
  return { targetId };
};

const readState = async (tx: Tx, action: (typeof actions)[number], targetId: string) => {
  const table = action.user ? users : institutions;
  const [row] = await tx
    .select({
      suspendedAt: table.suspendedAt,
      suspensionReason: table.suspensionReason,
      updatedAt: table.updatedAt,
    })
    .from(table)
    .where(eq(table.id, targetId));
  return row;
};

const readAudits = async (tx: Tx, action: (typeof actions)[number], targetId: string) => {
  const targetColumn = action.user
    ? platformOpsAuditLogs.targetUserId
    : platformOpsAuditLogs.targetInstitutionId;
  return tx
    .select({
      actorUserId: platformOpsAuditLogs.actorUserId,
      eventType: platformOpsAuditLogs.eventType,
      reason: platformOpsAuditLogs.reason,
    })
    .from(platformOpsAuditLogs)
    .where(eq(targetColumn, targetId));
};

describe.skipIf(skipWithoutDatabase).each(actions)("$name database actor integrity", (action) => {
  it.each([
    { label: "missing", code: "operator_actor_not_found" },
    { label: "candidate", code: "operator_actor_not_platform_ops" },
    { label: "suspended operator", code: "operator_actor_suspended" },
  ])("refuses a $label actor without state or audit changes", async ({ label, code }) => {
    await inRollback(async (tx) => {
      const { targetId } = await seedFixture(tx, action);
      const actorId =
        label === "missing"
          ? randomUUID()
          : await seedAccount(
              tx,
              label === "candidate" ? "candidate" : "platform_ops",
              label === "suspended operator",
            );
      const before = await readState(tx, action, targetId);
      const refusal = await action
        .service(actorId, targetId, "reason", tx)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({ code, status: 403 });
      expect(await readState(tx, action, targetId)).toEqual(before);
      expect(await readAudits(tx, action, targetId)).toHaveLength(0);
    });
  });

  it("succeeds with exactly one audit row naming the database operator", async () => {
    await inRollback(async (tx) => {
      const { targetId } = await seedFixture(tx, action);
      const actorId = await seedAccount(tx, "platform_ops");
      await action.service(actorId, targetId, " reason ", tx);
      const state = await readState(tx, action, targetId);
      expect(state?.suspendedAt === null).toBe(action.suspended);
      expect(state?.suspensionReason).toBe(action.suspended ? null : "reason");
      expect(await readAudits(tx, action, targetId)).toEqual([
        { actorUserId: actorId, eventType: action.event, reason: "reason" },
      ]);
    });
  });
});
