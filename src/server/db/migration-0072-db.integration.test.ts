// @vitest-environment node

// Migration 0072 against the database: the foreign key, the unique index and the CHECKs of
// host_trust_removals. Every test runs in a transaction that is always rolled back.

import { TransactionRollbackError, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import { hostTrustRemovals, users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

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
  throw new Error("expected the database to refuse this row, but it was accepted");
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

const seedUser = async (tx: Tx): Promise<string> => {
  const username = `mig72_${uniqueSuffix()}`;
  const [user] = await tx
    .insert(users)
    .values({
      email: `${username}@example.test`,
      username,
      emailVerified: new Date(),
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return user!.id;
};

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

describe.skipIf(skipWithoutDatabase)("migration 0072 against the database", () => {
  it("keeps a record and empties its account when the users row is deleted", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);
      const [record] = await tx
        .insert(hostTrustRemovals)
        .values({ userId, removedAt: new Date(), emailHashes: [HEX_B], keyCheck: HEX_A })
        .returning({ id: hostTrustRemovals.id });

      await tx.delete(users).where(eq(users.id, userId));

      const [kept] = await tx
        .select({ userId: hostTrustRemovals.userId, emailHashes: hostTrustRemovals.emailHashes })
        .from(hostTrustRemovals)
        .where(eq(hostTrustRemovals.id, record!.id));
      expect(kept!.userId).toBeNull();
      expect(kept!.emailHashes).toEqual([HEX_B]);
    });
  });

  it("allows one record per account and any number with no account", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);
      await tx.insert(hostTrustRemovals).values({ userId, removedAt: new Date(), keyCheck: HEX_A });

      const duplicate = await expectRejection(tx, (nested) =>
        nested.insert(hostTrustRemovals).values({ userId, removedAt: new Date(), keyCheck: HEX_A }),
      );

      expect(duplicate).toEqual({
        code: "23505",
        constraint: "host_trust_removals_user_id_unique_idx",
      });
      const first = await tx
        .insert(hostTrustRemovals)
        .values({ userId: null, removedAt: new Date(), keyCheck: HEX_A })
        .returning({ id: hostTrustRemovals.id });
      const second = await tx
        .insert(hostTrustRemovals)
        .values({ userId: null, removedAt: new Date(), keyCheck: HEX_A })
        .returning({ id: hostTrustRemovals.id });
      expect(first[0]!.id).not.toBe(second[0]!.id);
    });
  });

  it("refuses a raw address, a raw number, a null element, a key check that is not 64 lower-case hex and an upper-case domain, each by constraint name", async () => {
    await inRollback(async (tx) => {
      const rawAddress = await expectRejection(tx, (nested) =>
        nested.insert(hostTrustRemovals).values({
          removedAt: new Date(),
          emailHashes: ["budi@acme.example"],
          keyCheck: HEX_A,
        }),
      );
      const rawNumber = await expectRejection(tx, (nested) =>
        nested.insert(hostTrustRemovals).values({
          removedAt: new Date(),
          phoneHashes: ["6281234567890"],
          keyCheck: HEX_A,
        }),
      );
      const nullElement = await expectRejection(tx, (nested) =>
        nested.execute(
          sql`insert into host_trust_removals (removed_at, email_hashes, key_check) values (now(), array[null]::text[], ${HEX_A})`,
        ),
      );
      const upperCaseKeyCheck = await expectRejection(tx, (nested) =>
        nested
          .insert(hostTrustRemovals)
          .values({ removedAt: new Date(), keyCheck: "A".repeat(64) }),
      );
      const notAHash = await expectRejection(tx, (nested) =>
        nested.insert(hostTrustRemovals).values({ removedAt: new Date(), keyCheck: "not-a-hash" }),
      );
      const upperCaseDomain = await expectRejection(tx, (nested) =>
        nested.insert(hostTrustRemovals).values({
          removedAt: new Date(),
          organizationDomain: "Acme.example",
          keyCheck: HEX_A,
        }),
      );

      expect(rawAddress).toEqual({
        code: "23514",
        constraint: "host_trust_removals_email_hashes_hex_chk",
      });
      expect(rawNumber).toEqual({
        code: "23514",
        constraint: "host_trust_removals_phone_hashes_hex_chk",
      });
      expect(nullElement).toEqual({
        code: "23514",
        constraint: "host_trust_removals_email_hashes_hex_chk",
      });
      expect(upperCaseKeyCheck).toEqual({
        code: "23514",
        constraint: "host_trust_removals_key_check_hex_chk",
      });
      expect(notAHash).toEqual({
        code: "23514",
        constraint: "host_trust_removals_key_check_hex_chk",
      });
      expect(upperCaseDomain).toEqual({
        code: "23514",
        constraint: "host_trust_removals_organization_domain_lower_chk",
      });
      const [accepted] = await tx
        .insert(hostTrustRemovals)
        .values({
          removedAt: new Date(),
          emailHashes: [HEX_A, HEX_B],
          phoneHashes: [HEX_A],
          organizationDomain: "acme.example",
          keyCheck: HEX_B,
        })
        .returning({ id: hostTrustRemovals.id });
      expect(accepted!.id).toEqual(expect.any(String));
    });
  });

  it("gives the removal time no default, so every writer has to name one", async () => {
    await inRollback(async (tx) => {
      const refusal = await expectRejection(tx, (nested) =>
        nested.execute(sql`insert into host_trust_removals (key_check) values (${HEX_A})`),
      );

      expect(refusal.code).toBe("23502");
    });
  });
});
