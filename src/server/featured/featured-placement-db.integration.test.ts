// @vitest-environment node
//
// LAUNCH-D136, against a real Postgres.
//
// WHAT THIS FILE EXISTS TO PROVE. The unit suite stubs `assertOperatorHasNoInstitutionRelationship`,
// so it measures that the writer CALLS the helper and nothing about WHAT it passes. A writer that
// handed the helper the competition id instead of the owning institution's id would keep every stub
// green while refusing nobody. Here the helper is the real one, reading real membership rows, so the
// refusal only appears when the right id reaches it (Rule 33).
//
// Every test runs inside a transaction that is ALWAYS rolled back. Nothing here is committed.

import { afterAll, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitions,
  institutionMemberships,
  institutions,
  platformOpsAuditLogs,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { FEATURED_SET_EVENT, setFeaturedPlacement } from "./featured-placement-service";

// The search sync is a queue write on a different system and is not what this file measures.
vi.mock("@/server/async/enqueue", () => ({
  enqueueCompetitionSearchSync: vi.fn().mockResolvedValue(undefined),
}));

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const NOW = new Date("2026-10-16T00:00:00.000Z");

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

const seedPlatformOps = async (tx: Tx): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `featured_ops_${id}@example.test`,
      username: `featured_ops_${id}`,
      role: "platform_ops",
      // users_one_verified_role_chk requires at least one verified role.
      candidateVerifiedAt: NOW,
    })
    .returning({ id: users.id });
  return row!.id;
};

// A `company` institution: personal institutions are refused for featuring before the write, which
// would end a test on the wrong refusal.
const seedPublishedCompetition = async (
  tx: Tx,
  label: string,
): Promise<{ institutionId: string; competitionId: string }> => {
  const id = uniqueSuffix();
  const [institution] = await tx
    .insert(institutions)
    .values({
      displayName: `Featured fixture ${label}`,
      slug: `featured-${label}-${id}`,
      institutionType: "company",
    })
    .returning({ id: institutions.id });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `featured-${label}-comp-${id}`,
      title: `Featured fixture ${label} ${id}`,
      status: "published",
    })
    .returning({ id: competitions.id });

  return { institutionId: institution!.id, competitionId: competition!.id };
};

const giveMembership = async (tx: Tx, institutionId: string, userId: string): Promise<void> => {
  await tx.insert(institutionMemberships).values({
    institutionId,
    userId,
    membershipRole: "institution_member",
    status: "active",
  });
};

const readPlacement = async (tx: Tx, competitionId: string) => {
  const [row] = await tx
    .select({ isFeatured: competitions.isFeatured, featuredOrder: competitions.featuredOrder })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row!;
};

const auditRowsBy = async (tx: Tx, actorUserId: string) =>
  tx
    .select({
      actorUserId: platformOpsAuditLogs.actorUserId,
      targetInstitutionId: platformOpsAuditLogs.targetInstitutionId,
      eventType: platformOpsAuditLogs.eventType,
    })
    .from(platformOpsAuditLogs)
    .where(eq(platformOpsAuditLogs.actorUserId, actorUserId));

describe.skipIf(skipWithoutDatabase)(
  "setFeaturedPlacement institution conflict (real database)",
  () => {
    it("refuses an operator holding a membership in the competition's institution, changing and auditing nothing", async () => {
      await inRollback(async (tx) => {
        const operatorId = await seedPlatformOps(tx);
        const affected = await seedPublishedCompetition(tx, "affected");
        await giveMembership(tx, affected.institutionId, operatorId);
        const before = await readPlacement(tx, affected.competitionId);

        await expect(
          setFeaturedPlacement(
            operatorId,
            affected.competitionId,
            { isFeatured: true, featuredOrder: 1 },
            tx,
          ),
        ).rejects.toMatchObject({ code: "operator_actor_conflicted", status: 403 });

        expect(await readPlacement(tx, affected.competitionId)).toEqual(before);
        expect(await auditRowsBy(tx, operatorId)).toHaveLength(0);
      });
    });

    it("lets the same operator feature a competition of an institution it has no relationship to, with one audit row naming it", async () => {
      await inRollback(async (tx) => {
        const operatorId = await seedPlatformOps(tx);
        const tied = await seedPublishedCompetition(tx, "tied");
        const unrelated = await seedPublishedCompetition(tx, "unrelated");
        await giveMembership(tx, tied.institutionId, operatorId);

        await setFeaturedPlacement(
          operatorId,
          unrelated.competitionId,
          { isFeatured: true, featuredOrder: 2 },
          tx,
        );

        expect(await readPlacement(tx, unrelated.competitionId)).toEqual({
          isFeatured: true,
          featuredOrder: 2,
        });
        expect(await auditRowsBy(tx, operatorId)).toEqual([
          {
            actorUserId: operatorId,
            targetInstitutionId: unrelated.institutionId,
            eventType: FEATURED_SET_EVENT,
          },
        ]);
      });
    });
  },
);
