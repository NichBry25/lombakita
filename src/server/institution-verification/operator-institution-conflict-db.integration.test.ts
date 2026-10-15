// @vitest-environment node
//
// LAUNCH-D136, against a real Postgres.
//
// WHAT THIS FILE EXISTS TO PROVE. The unit suite builds the three tables' answers by hand, so it
// measures the order in which the helper asks and nothing about what each query selects. Each arm
// here reads real rows, and each is held to both halves of its contract: a relationship on
// institution A refuses for A, and the same relationship does NOT refuse for institution B. The
// second half is the one a dropped institution scope would break while the first stayed green.
//
// Every test runs inside a transaction that is ALWAYS rolled back. Nothing here is committed.

import { afterAll, describe, expect, it } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  institutionInvitations,
  institutionMemberships,
  institutionVerificationSubmissions,
  institutions,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { resolvePlatformOpsActor } from "@/server/platform-ops/operator-actor";
import { assertOperatorHasNoInstitutionRelationship } from "./operator-institution-conflict";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const NOW = new Date("2026-10-16T00:00:00.000Z");
const FUTURE = new Date("2026-12-16T00:00:00.000Z");

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

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

type SeededOperator = { id: string; email: string };

// The address is mixed-case on purpose: the invitation in the email arm is stored lower-case, so
// only a comparison that normalises the account's address reaches it.
const seedOperator = async (tx: Tx): Promise<SeededOperator> => {
  const suffix = uniqueSuffix();
  const email = `Conflict_Ops_${suffix}@Example.test`;
  const [row] = await tx
    .insert(users)
    .values({
      email,
      username: `conflict_ops_${suffix}`,
      role: "platform_ops",
      // users_one_verified_role_chk requires at least one verified role.
      candidateVerifiedAt: NOW,
    })
    .returning({ id: users.id });
  return { id: row!.id, email };
};

const seedInstitution = async (tx: Tx, label: string): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(institutions)
    .values({
      displayName: `Conflict fixture ${label}`,
      slug: `conflict-${label}-${id}`,
      institutionType: "company",
    })
    .returning({ id: institutions.id });
  return row!.id;
};

type Arm = {
  label: string;
  relate: (tx: Tx, institutionId: string, operator: SeededOperator) => Promise<void>;
};

const arms: Arm[] = [
  {
    label: "a membership in any status",
    relate: async (tx, institutionId, operator) => {
      await tx.insert(institutionMemberships).values({
        institutionId,
        userId: operator.id,
        membershipRole: "institution_member",
        status: "revoked",
      });
    },
  },
  {
    label: "a filed verification submission",
    relate: async (tx, institutionId, operator) => {
      await tx.insert(institutionVerificationSubmissions).values({
        institutionId,
        submittedByUserId: operator.id,
        targetInstitutionType: "company",
        status: "rejected",
      });
    },
  },
  {
    label: "an invitation by target_user_id",
    relate: async (tx, institutionId, operator) => {
      await tx.insert(institutionInvitations).values({
        institutionId,
        invitedEmail: `someone_else_${uniqueSuffix()}@example.test`,
        invitedRole: "institution_member",
        tokenHash: `token_${uniqueSuffix()}`,
        status: "declined",
        targetUserId: operator.id,
        expiresAt: FUTURE,
      });
    },
  },
  {
    label: "an invitation by normalized email",
    relate: async (tx, institutionId, operator) => {
      await tx.insert(institutionInvitations).values({
        institutionId,
        invitedEmail: operator.email.toLowerCase(),
        invitedRole: "institution_member",
        tokenHash: `token_${uniqueSuffix()}`,
        status: "pending_claim",
        targetUserId: null,
        expiresAt: FUTURE,
      });
    },
  },
];

describe.skipIf(skipWithoutDatabase).each(arms)(
  "assertOperatorHasNoInstitutionRelationship, arm: $label (real database)",
  (arm) => {
    it("refuses for the institution the relationship is on", async () => {
      await inRollback(async (tx) => {
        const operator = await seedOperator(tx);
        const institutionA = await seedInstitution(tx, "a");
        await arm.relate(tx, institutionA, operator);
        const actor = await resolvePlatformOpsActor(tx, operator.id);

        await expect(
          assertOperatorHasNoInstitutionRelationship(tx, actor, institutionA),
        ).rejects.toMatchObject({ code: "operator_actor_conflicted", status: 403 });
      });
    });

    it("does not refuse for a different institution", async () => {
      await inRollback(async (tx) => {
        const operator = await seedOperator(tx);
        const institutionA = await seedInstitution(tx, "a");
        const institutionB = await seedInstitution(tx, "b");
        await arm.relate(tx, institutionA, operator);
        const actor = await resolvePlatformOpsActor(tx, operator.id);

        await expect(
          assertOperatorHasNoInstitutionRelationship(tx, actor, institutionB),
        ).resolves.toBeUndefined();
      });
    });
  },
);
