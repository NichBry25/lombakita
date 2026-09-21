// @vitest-environment node
//
// LAUNCH-D72, against a real Postgres.
//
// WHAT THIS FILE EXISTS TO PROVE, and why it is not a unit test. The unit suite builds the acting
// account as a hand-written object, so it measures `resolvePlatformOpsActor` as a function and
// nothing about the wiring: a version that was never called, or called with the caller's own
// string, would pass it. Every actor below is a real `users` row and every refusal is produced by
// calling `elevateRecruiterTier` — the production path — against a real connection (Rule 33).
//
// The target account is real too, and asserted unchanged after each refusal, because a refusal that
// still wrote the elevation would satisfy "it threw" while being the failure it is meant to be.
//
// Every test runs inside a transaction that is ALWAYS rolled back. Nothing here is committed.

import { afterAll, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { platformOpsAuditLogs, users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { getDb, type Database } from "@/server/db/client";
import {
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
  type ResolvedPlatformOpsActor,
} from "@/server/platform-ops/operator-actor";

// The elevation path's last act is an object-storage sweep, which is a different module's side
// effect on a different system and is not what this file measures. Stubbed for the same reason the
// unit suite stubs it: so a refusal is the guard and not an unreachable bucket.
const { mockSweepForAccount } = vi.hoisted(() => ({
  mockSweepForAccount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/recruiter-verification/recruiter-verification-service", () => ({
  sweepOrphanedObjectsForAccount: mockSweepForAccount,
}));

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
// Built with the schema, as `getDb()` is. Without it the transaction handle carries an empty schema
// and is not assignable to the `Database` the services take, which is a type error rather than a
// runtime one — and the point of this file is to call the real services.
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

// Derived from the application's own `Database` rather than from a fresh `drizzle()` call, so the
// handle this file's transaction produces is the one the services accept.
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

type SeedAccount = {
  role: "candidate" | "recruiter" | "platform_ops";
  recruiterTier?: "unverified" | "minimal" | "elevated";
  suspended?: boolean;
};

/**
 * A real `users` row.
 *
 * `users_one_verified_role_chk` requires at least one verified role and
 * `users_recruiter_tier_consistency_chk` forbids `unverified` alongside a verified recruiter, so
 * the two are set together rather than one at a time.
 */
const seedAccount = async (tx: Tx, account: SeedAccount): Promise<string> => {
  const id = uniqueSuffix();
  const recruiterTier = account.recruiterTier ?? "unverified";

  const [row] = await tx
    .insert(users)
    .values({
      email: `ops_actor_${id}@example.test`,
      username: `ops_actor_${id}`,
      role: account.role,
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: recruiterTier === "unverified" ? null : new Date(),
      recruiterVerificationTier: recruiterTier,
      suspendedAt: account.suspended ? new Date() : null,
      suspensionReason: account.suspended ? "integration fixture" : null,
    })
    .returning({ id: users.id });

  return row!.id;
};

const readTier = async (tx: Tx, userId: string): Promise<string> => {
  const [row] = await tx
    .select({ tier: users.recruiterVerificationTier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row!.tier;
};

const auditRowsFor = async (tx: Tx, targetUserId: string) => {
  return tx
    .select({
      actorUserId: platformOpsAuditLogs.actorUserId,
      targetUserId: platformOpsAuditLogs.targetUserId,
      eventType: platformOpsAuditLogs.eventType,
    })
    .from(platformOpsAuditLogs)
    .where(eq(platformOpsAuditLogs.targetUserId, targetUserId));
};

const elevate = async (tx: Tx, actorUserId: string, accountId: string) => {
  const { elevateRecruiterTier } = await import("@/server/recruiter-tier/recruiter-tier-service");
  return elevateRecruiterTier(actorUserId, accountId, tx);
};

describe.skipIf(skipWithoutDatabase)("elevateRecruiterTier against a real database", () => {
  it("refuses an actor who does not exist, and leaves the target alone", async () => {
    await inRollback(async (tx) => {
      const target = await seedAccount(tx, { role: "recruiter", recruiterTier: "minimal" });

      await expect(elevate(tx, `absent_${uniqueSuffix()}`, target)).rejects.toMatchObject({
        code: "operator_actor_not_found",
        status: 403,
      });

      expect(await readTier(tx, target)).toBe("minimal");
      expect(await auditRowsFor(tx, target)).toHaveLength(0);
    });
  });

  // THE ORDERING, PINNED WITH A TARGET THAT DOES NOT EXIST. The service's docstring claims the actor
  // is read first, "so a caller that has no business here learns nothing about the target, not even
  // whether it exists" — and every other test in this file passes a real target, so all of them pass
  // just as well against an implementation that read the target first. Here the target is absent AND
  // the actor is invalid. If the target read came first the refusal would be `tier_account_not_found`
  // and the caller would have learned that the id it named is unassigned.
  it("refuses an invalid actor without reading the target, so the target's existence is undisclosed", async () => {
    await inRollback(async (tx) => {
      const absentTarget = `absent_target_${uniqueSuffix()}`;
      const actor = await seedAccount(tx, { role: "candidate" });

      const refusal = await elevate(tx, actor, absentTarget).then(
        () => null,
        (error: { code?: string; status?: number }) => error,
      );

      expect(refusal?.code, "the target was read before the actor was resolved").toBe(
        "operator_actor_not_platform_ops",
      );
      expect(refusal?.code).not.toBe("tier_account_not_found");
    });
  });

  it("refuses an actor who exists but does not hold platform_ops", async () => {
    await inRollback(async (tx) => {
      const target = await seedAccount(tx, { role: "recruiter", recruiterTier: "minimal" });
      // A real account, verified in the ordinary way, holding the wrong role. The distinction from
      // the case above is the point: the FK on `actor_user_id` is satisfied by this id, so a check
      // that only proved existence would accept it.
      const actor = await seedAccount(tx, { role: "candidate" });

      await expect(elevate(tx, actor, target)).rejects.toMatchObject({
        code: "operator_actor_not_platform_ops",
        status: 403,
      });

      expect(await readTier(tx, target)).toBe("minimal");
      expect(await auditRowsFor(tx, target)).toHaveLength(0);
    });
  });

  it("refuses an actor who holds platform_ops but is suspended", async () => {
    await inRollback(async (tx) => {
      const target = await seedAccount(tx, { role: "recruiter", recruiterTier: "minimal" });
      const actor = await seedAccount(tx, { role: "platform_ops", suspended: true });

      await expect(elevate(tx, actor, target)).rejects.toMatchObject({
        code: "operator_actor_suspended",
        status: 403,
      });

      expect(await readTier(tx, target)).toBe("minimal");
      expect(await auditRowsFor(tx, target)).toHaveLength(0);
    });
  });

  it("elevates for a live platform_ops actor, and the audit row names that account", async () => {
    await inRollback(async (tx) => {
      const target = await seedAccount(tx, { role: "recruiter", recruiterTier: "minimal" });
      const actor = await seedAccount(tx, { role: "platform_ops" });

      const result = await elevate(tx, actor, target);

      expect(result).toEqual({ accountId: target, tier: "elevated", changed: true });
      expect(await readTier(tx, target)).toBe("elevated");

      const rows = await auditRowsFor(tx, target);
      expect(rows).toEqual([
        {
          actorUserId: actor,
          targetUserId: target,
          eventType: "recruiter_tier.elevated",
        },
      ]);
    });
  });

  // The suspended account is the one an operator is most likely to believe is still an operator:
  // the role is untouched by suspension, the session keeps its claims until it is re-read, and the
  // audit row it would write is indistinguishable from a live operator's. Suspending the actor and
  // re-running the SAME id is what shows the check reads the column rather than the role.
  it("stops elevating for an actor the moment that actor is suspended", async () => {
    await inRollback(async (tx) => {
      const target = await seedAccount(tx, { role: "recruiter", recruiterTier: "minimal" });
      const actor = await seedAccount(tx, { role: "platform_ops" });

      expect((await elevate(tx, actor, target)).changed).toBe(true);

      await tx.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, actor));

      const second = await seedAccount(tx, { role: "recruiter", recruiterTier: "minimal" });
      await expect(elevate(tx, actor, second)).rejects.toMatchObject({
        code: "operator_actor_suspended",
      });
      expect(await readTier(tx, second)).toBe("minimal");
    });
  });
});

// WHAT THIS ASSERTS IS A COMPILE ERROR, and the directives are what make its ABSENCE a failure.
// `@ts-expect-error` is itself an error when nothing is wrong, so if the class became a value
// export, or gained a public way to build one, or `recordOperatorAuditEntry` gained an overload
// taking a string, `npm run typecheck` goes red naming this test. The body is never executed — the
// probes are inside a function that is only measured, never called — so no connection is opened and
// no row is written.
describe("the shape that makes omission a compile error", () => {
  it("offers no way to name an actor that the database did not resolve", () => {
    const compileTimeOnly = (): void => {
      // @ts-expect-error the pool is not a transaction, so the actor cannot be read outside one
      void resolvePlatformOpsActor(getDb(), "someone");
      // @ts-expect-error a private member makes the class nominal, so no object literal can build the type
      const forged: ResolvedPlatformOpsActor = { userId: "someone" };
      // @ts-expect-error copy-and-overwrite does not carry the private member, so the spread is refused too
      const copied: ResolvedPlatformOpsActor = { ...forged, userId: "someone else" };
      // @ts-expect-error the audit row takes the resolved actor, never a string
      void recordOperatorAuditEntry(null as never, "someone", { eventType: "x" });
      void forged;
      void copied;
    };

    expect(typeof compileTimeOnly).toBe("function");
  });
});
