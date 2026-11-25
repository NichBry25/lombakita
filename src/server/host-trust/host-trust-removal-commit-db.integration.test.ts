// @vitest-environment node

// Whether the trust removal opt-in outlives the removing transaction, against committed rows. A
// rolled-back test cannot show it, because the opt-in is meant to end with its transaction. The two
// accounts are planted directly and swept by their username marker, in afterEach and on a signal,
// and afterAll asserts that none survived.

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({ enqueueRemoved: vi.fn(async (_input: unknown) => ({})) }));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: { ...actual.serverEnv, authSecret: "test-registration-code-secret" },
  };
});

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, enqueueHostTrustRemoved: mocks.enqueueRemoved };
});

import { removeHostTrust } from "./host-trust-removal-service";

const COMMIT_MARKER = "host_trust_removal_commit";
const REASON = "Kontak palsu di beberapa kompetisi.";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

const markerPattern = `${COMMIT_MARKER}_%`;

const committedUsername = (label: string): string =>
  `${COMMIT_MARKER}_${label}_${Date.now().toString(36)}`;

// Planted directly and committed: a trusted host and an operator, because only a committed removal
// shows what is left of the opt-in once its transaction ends.
const seedCommittedHostAndOperator = async (): Promise<{ host: string; operator: string }> => {
  if (!db) throw new Error("No test database");
  const hostName = committedUsername("host");
  const operatorName = committedUsername("ops");
  const [host] = await db
    .insert(schema.users)
    .values({
      email: `${hostName}@example.test`,
      username: hostName,
      role: "recruiter",
      emailVerified: new Date(),
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    })
    .returning({ id: schema.users.id });
  const [operator] = await db
    .insert(schema.users)
    .values({
      email: `${operatorName}@example.test`,
      username: operatorName,
      role: "platform_ops",
      emailVerified: new Date(),
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!host || !operator) throw new Error("No committed account row");
  return { host: host.id, operator: operator.id };
};

// Deletes every account any run of this file has committed, matched by marker so it also removes
// what a crashed run left behind. Their audit rows go first, because the audit table restricts the
// deletion of an account it names.
const sweepCommittedRows = async (): Promise<void> => {
  if (!db) return;
  await db.execute(
    sql`delete from platform_ops_audit_logs where actor_user_id in (select id from users where username like ${markerPattern}) or target_user_id in (select id from users where username like ${markerPattern})`,
  );
  await db.execute(sql`delete from users where username like ${markerPattern}`);
};

const countCommittedAccounts = async (): Promise<number> => {
  if (!db) return 0;
  const rows = (await db.execute(
    sql`select count(*)::int as count from users where username like ${markerPattern}`,
  )) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? -1;
};

// A new transaction on the same session, which is where a value left at session level would show.
const readTrustRemovalSetting = async (): Promise<string | null> => {
  if (!db) throw new Error("No test database");
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(
      sql`select current_setting('lombakita.trust_removal', true) as setting`,
    )) as unknown as Array<{ setting: string | null }>;
    return rows[0]?.setting ?? null;
  });
};

const purgeOnSignal = () => {
  void sweepCommittedRows().catch(() => undefined);
};

describe.skipIf(skipWithoutDatabase)(
  "the trust removal opt-in after the removal commits (committed rows)",
  () => {
    beforeAll(async () => {
      await sweepCommittedRows();
      process.on("SIGINT", purgeOnSignal);
      process.on("SIGTERM", purgeOnSignal);
    });

    // In afterEach so an assertion failing mid-test cannot skip the cleanup of committed rows.
    afterEach(async () => {
      await sweepCommittedRows();
    });

    afterAll(async () => {
      process.off("SIGINT", purgeOnSignal);
      process.off("SIGTERM", purgeOnSignal);
      try {
        await sweepCommittedRows();
        expect(await countCommittedAccounts(), "committed accounts left behind").toBe(0);
      } finally {
        await client?.end();
      }
    });

    it("leaves no opt-in for a later transaction once the removal has committed", async () => {
      const { host, operator } = await seedCommittedHostAndOperator();

      const removed = await removeHostTrust(operator, host, REASON, db as unknown as Database);

      expect(removed).toEqual({ accountId: host, tier: "minimal" });
      const [hostRow] = await db!
        .select({ tier: schema.users.recruiterVerificationTier })
        .from(schema.users)
        .where(eq(schema.users.id, host));
      expect(hostRow?.tier).toBe("minimal");
      expect((await readTrustRemovalSetting()) ?? "").toBe("");
    });
  },
);
