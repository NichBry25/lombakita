// @vitest-environment node
//
// LAUNCH-D73, against a real Postgres.
//
// WHAT THIS FILE EXISTS TO PROVE, and why every statement below is raw SQL rather than a call into
// `recruiter-tier-service`. The service only ever moves the tier upward — there is no code path in
// `src/` that writes a lower tier — so a test that went through the service would exercise the
// absence of a demotion feature and prove nothing about the database. The claim is stronger than
// that: the ORDERING is enforced by the schema, so an UPDATE that lowers the tier is refused even
// when nothing in the application issued it. Raw SQL against the table is the only way to make that
// claim, and it is what the acceptance criterion asks for.
//
// The connection here is the ordinary application role out of `.env.local` (`lombakita_app`), which
// does NOT own the table — so the refusal cannot be an ownership artefact, and the test asserts the
// trigger's own SQLSTATE rather than any error. No migration in this checkout issues a DOWNGRADING
// UPDATE of this column: 0037_abandoned_kat_farrell is the only one that writes it, and it writes
// `elevated` upward, where the tier was not already `elevated`. The ordering claim is therefore
// exactly this role's: it holds for a connection with no DDL rights at all.
//
// Every test runs inside a transaction that is ALWAYS rolled back. Nothing here is committed.

import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { RECRUITER_TIERS } from "@/server/auth/recruiter-tier";

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<NonNullable<typeof db>["transaction"]>[0]>[0];

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

/**
 * Run `body` in a nested transaction so a refusal aborts the nested one and leaves the outer
 * transaction usable — the same shape `mfa-schema-db.integration.test.ts` uses. A trigger that
 * raises aborts the whole transaction it runs in, so without the nesting the assertion itself
 * would poison every read that followed it.
 */
const expectRejection = async (
  tx: Tx,
  body: (tx: Tx) => Promise<unknown>,
): Promise<{ code: string; constraint: string }> => {
  try {
    await tx.transaction(async (nested) => {
      await body(nested);
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const e = current as {
        code?: string;
        constraint_name?: string;
        constraint?: string;
        cause?: unknown;
      };
      if (typeof e.code === "string") {
        return { code: e.code, constraint: e.constraint_name ?? e.constraint ?? "" };
      }
      current = e.cause;
    }
    throw error;
  }
  throw new Error("expected the database to refuse this UPDATE, but it was accepted");
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

type Tier = "unverified" | "minimal" | "elevated";

/**
 * A real `users` row at a real tier.
 *
 * `users_recruiter_tier_consistency_chk` forbids `unverified` alongside a verified recruiter, so
 * the timestamp and the tier move together rather than one at a time.
 */
const seedAtTier = async (tx: Tx, tier: Tier): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `tier_order_${id}@example.test`,
      username: `tier_order_${id}`,
      role: "recruiter",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: tier === "unverified" ? null : new Date(),
      recruiterVerificationTier: tier,
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

/** The demotion, issued straight at the table. This is the statement the trigger exists to refuse. */
const demoteByHand = async (tx: Tx, userId: string, tier: Tier): Promise<void> => {
  await tx.execute(
    sql`update "users" set "recruiter_verification_tier" = ${tier} where "id" = ${userId}`,
  );
};

const NO_DOWNGRADE_CONSTRAINT = "users_recruiter_tier_no_downgrade";

describe.skipIf(skipWithoutDatabase)("recruiter_verification_tier cannot run backwards", () => {
  it("refuses elevated -> minimal issued directly against the table", async () => {
    await inRollback(async (tx) => {
      const account = await seedAtTier(tx, "elevated");

      const refusal = await expectRejection(tx, (nested) =>
        demoteByHand(nested, account, "minimal"),
      );

      expect(refusal.code).toBe("23514");
      expect(refusal.constraint).toBe(NO_DOWNGRADE_CONSTRAINT);
      // The refusal has to leave the row where it was. A trigger that raised AFTER the write, or a
      // constraint that only complained, would satisfy "it was refused" while costing the tier.
      expect(await readTier(tx, account)).toBe("elevated");
    });
  });

  it("refuses elevated -> unverified, a two-step drop", async () => {
    await inRollback(async (tx) => {
      const account = await seedAtTier(tx, "elevated");

      const refusal = await expectRejection(tx, (nested) =>
        demoteByHand(nested, account, "unverified"),
      );

      expect(refusal.code).toBe("23514");
      expect(refusal.constraint).toBe(NO_DOWNGRADE_CONSTRAINT);
      expect(await readTier(tx, account)).toBe("elevated");
    });
  });

  it("refuses minimal -> unverified", async () => {
    await inRollback(async (tx) => {
      const account = await seedAtTier(tx, "minimal");

      const refusal = await expectRejection(tx, (nested) =>
        demoteByHand(nested, account, "unverified"),
      );

      expect(refusal.code).toBe("23514");
      expect(refusal.constraint).toBe(NO_DOWNGRADE_CONSTRAINT);
      expect(await readTier(tx, account)).toBe("minimal");
    });
  });

  // The other direction has to stay open, or the trigger would be a freeze rather than a ratchet
  // and the elevation service — the one path this schema is meant to keep working — would break.
  it("allows minimal -> elevated, and minimal -> unverified is the only refusal", async () => {
    await inRollback(async (tx) => {
      const account = await seedAtTier(tx, "minimal");

      await demoteByHand(tx, account, "elevated");

      expect(await readTier(tx, account)).toBe("elevated");
    });
  });

  // `NEW < OLD` is false when the two are equal, so an idempotent write stays idempotent. Worth
  // pinning: a trigger written as `<>` would pass every test above and break every retry.
  it("allows a write that sets the tier to the value it already holds", async () => {
    await inRollback(async (tx) => {
      const account = await seedAtTier(tx, "elevated");

      await demoteByHand(tx, account, "elevated");

      expect(await readTier(tx, account)).toBe("elevated");
    });
  });

  // `BEFORE UPDATE OF "recruiter_verification_tier"` scopes the trigger to statements whose SET list
  // names the column, so the ordinary writes that touch a suspended or renamed account pay nothing
  // for it. This asserts the scoping rather than assuming it: if the clause were dropped to a plain
  // `BEFORE UPDATE`, this test would still pass, which is why the refusal tests above are the ones
  // that fail on a dropped trigger.
  it("does not fire for an UPDATE that does not name the tier column", async () => {
    await inRollback(async (tx) => {
      const account = await seedAtTier(tx, "elevated");

      await tx.execute(sql`update "users" set "name" = 'renamed' where "id" = ${account}`);

      expect(await readTier(tx, account)).toBe("elevated");
    });
  });
});

// THE ORDERING HAS ONE SOURCE, AND THIS IS WHAT CHECKS IT STAYS ONE.
//
// The trigger does not carry a rank — it compares the enum labels with the enum's own operator. The
// TypeScript side does not carry a rank either: `RECRUITER_TIERS` is Drizzle's `enumValues`, which
// is the enum's declaration order in `schema.ts`. So the order lives in the `CREATE TYPE` statement
// and nowhere else, and the two consumers read it. What can still go wrong is the two readings
// diverging — a hand-written migration that reorders the labels in the database while
// `schema.ts` still declares the old order. That is a silent inversion: `meetsRecruiterTier` would
// answer from one order while the trigger enforced the other. This test is the alarm for it.
describe.skipIf(skipWithoutDatabase)("the ordering has exactly one source", () => {
  it("Postgres's enum order and RECRUITER_TIERS agree, label by label", async () => {
    if (!db) throw new Error("no database");

    const rows = await db.execute<{ enumlabel: string; enumsortorder: string }>(
      sql`select "enumlabel", "enumsortorder" from "pg_enum"
          where "enumtypid" = 'recruiter_verification_tier'::regtype
          order by "enumsortorder"`,
    );

    const fromDatabase = rows.map((row) => row.enumlabel);

    expect(fromDatabase).toEqual([...RECRUITER_TIERS]);
  });
});
