// @vitest-environment node
//
// WHAT THE PROMOTION STATEMENT ACTUALLY DOES WITH A LEFTOVER, measured against a live Postgres.
//
// The leftovers rule says an account tied to another person's data is not promoted. The census rules
// each of the 47 foreign keys into `users`, the document embeds statements rendered from those
// rulings, and the unit tests compare the two as text. None of that shows the statement behaves: a
// guard that is present can still be wrong, in the wrong place, or aimed at the wrong column. So this
// suite stops reading and starts promoting. For EVERY ruled edge it plants one row tying a fresh
// account to that edge, runs the DOCUMENT's own `preconditions` and `promote` statements against it,
// and asserts the outcome the ruling predicts:
//
//   blocks  → `promote` matches 0 rows, the role is unchanged, and the listing names the source;
//   allowed → `promote` matches 1 row.
//
// The rows are planted by the same planters the deletion oracle uses (`census-row-planters.ts`), so
// the two oracles cannot disagree about what a tie on an edge looks like. The statements are read
// from the procedure document, never restated here: a guard removed from the document turns its
// own edge red.
//
// EVERYTHING ROLLS BACK. Each case runs in its own transaction that is rolled back, and a last test
// counts the accounts and the operators before and after the suite (Rule 35).
//
// NOTHING HERE TOUCHES A NON-LOCAL HOST. The connection string is refused unless its host is
// loopback, before a single byte is sent.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeInviteEmail } from "@/server/invitations/claim-service";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { isLocalDatabaseHost, parseDatabaseHost } from "../lib/local-database-host";
import {
  ALL_PROBES,
  buildFixture,
  EXPIRES_AT,
  type Fixture,
  type Probe,
  type Sql,
} from "./census-row-planters";
import {
  blockingRulings,
  EMAIL_KEYED_ARMS,
  LEFTOVER_RULINGS,
  type LeftoverRuling,
} from "./promotion-leftover-census";
import { parseProcedure, PROCEDURE_PATH } from "./run-provisioning-procedure";

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;

const steps = parseProcedure(readFileSync(PROCEDURE_PATH, "utf8"));

const statementOf = (name: string): string => {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined || step.kind !== "sql") {
    throw new Error(`the procedure declares no sql step named \`${name}\``);
  }
  return step.body;
};

const preconditionsSql = statementOf("preconditions");
const promoteSql = statementOf("promote");

type Leftover = { source: string; n: number };

type Attempt = { leftovers: Leftover[]; affected: number; role: string };

/** Thrown to force `sql.begin` to roll back; caught immediately after. */
class OracleRollback extends Error {}

const inRollback = async (body: (tx: Sql) => Promise<void>): Promise<void> => {
  if (!client) throw new Error("no database");

  await client
    .begin(async (rawTx) => {
      // postgres.js types `TransactionSql` as an `Omit<Sql>`, which drops the call signature even
      // though the value is callable; the cast is the type system's, not the runtime's.
      await body(rawTx as unknown as Sql);
      throw new OracleRollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof OracleRollback)) throw error;
    });
};

/** A fresh account no probe has tied to anything, promotable as far as its role goes. */
const insertPromotee = async (tx: Sql, email?: string): Promise<string> => {
  const id = randomUUID();

  await tx`insert into users (id, email, username, candidate_verified_at)
    values (${id}, ${email ?? `oracle-promotee-${id}@example.test`}, ${`oracle_promotee_${id.slice(0, 8)}`}, now())`;

  return id;
};

/** The document's own statements, run in the order the document runs them, against one account. */
const attemptPromotion = async (tx: Sql, userId: string): Promise<Attempt> => {
  const [preconditions] = (await tx.unsafe(preconditionsSql, [userId])) as unknown as {
    leftovers: Leftover[];
  }[];
  const promoted = await tx.unsafe(promoteSql, [userId]);
  const [account] = await tx<
    { role: string }[]
  >`select role::text as role from users where id = ${userId}`;

  return {
    leftovers: preconditions!.leftovers,
    affected: promoted.count,
    role: account!.role,
  };
};

const edgeKey = (ruling: { table: string; column: string }): string =>
  `${ruling.table}.${ruling.column}`;

const probeFor = (ruling: LeftoverRuling): Probe => {
  const found = ALL_PROBES.find((entry) => entry.keys.includes(edgeKey(ruling)));
  if (found === undefined) {
    throw new Error(`no row planter exists for ${edgeKey(ruling)}, so the oracle cannot test it`);
  }
  return found;
};

/** The fixture graph, with the account under promotion substituted for the subject it builds. */
const plantFor = async (tx: Sql, ruling: LeftoverRuling): Promise<string> => {
  const base = await buildFixture(tx);
  const promotee = await insertPromotee(tx);
  const fixture: Fixture = { ...base, subject: promotee };

  await probeFor(ruling).plant(tx, fixture);

  return promotee;
};

let usersBefore = "";

const countAccounts = async (): Promise<string> => {
  const [row] = await client!<{ total: string; operators: string }[]>`
    select count(*)::text as total,
           count(*) filter (where role in ('platform_ops', 'finance_ops'))::text as operators
    from users`;
  return `${row!.total} accounts, ${row!.operators} operators`;
};

beforeAll(async () => {
  if (!DATABASE_URL || !client) return;

  // The guard comes before the first query, not after the first failure.
  if (!isLocalDatabaseHost(DATABASE_URL)) {
    throw new Error(
      `refusing to run the promotion leftover oracle against ${parseDatabaseHost(DATABASE_URL) ?? "an unparseable host"}: ` +
        "it promotes accounts, inside a rolled-back transaction, but only a loopback database is ever a place to try that",
    );
  }

  usersBefore = await countAccounts();
});

afterAll(async () => {
  await client?.end();
});

describe.skipIf(skipWithoutDatabase)("the promotion statement against every ruled edge", () => {
  it("has a row planter for every ruled edge, so no edge goes untested", () => {
    for (const ruling of LEFTOVER_RULINGS) {
      expect(() => probeFor(ruling), edgeKey(ruling)).not.toThrow();
    }
  });

  it.each(blockingRulings().map((ruling) => [edgeKey(ruling), ruling] as const))(
    "refuses an account tied by %s: 0 rows, role unchanged, the source named",
    async (_name, ruling) => {
      await inRollback(async (tx) => {
        const promotee = await plantFor(tx, ruling);

        const attempt = await attemptPromotion(tx, promotee);

        expect(attempt.affected).toBe(0);
        expect(attempt.role).toBe("candidate");
        expect(attempt.leftovers.map((leftover) => leftover.source)).toContain(edgeKey(ruling));
      });
    },
  );

  it.each(
    LEFTOVER_RULINGS.filter((ruling) => ruling.ruling === "allowed").map(
      (ruling) => [edgeKey(ruling), ruling] as const,
    ),
  )("promotes an account whose only tie is %s: 1 row, nothing listed", async (_name, ruling) => {
    await inRollback(async (tx) => {
      const promotee = await plantFor(tx, ruling);

      const attempt = await attemptPromotion(tx, promotee);

      expect(attempt.affected).toBe(1);
      expect(attempt.role).toBe("platform_ops");
      expect(attempt.leftovers).toEqual([]);
    });
  });

  it("promotes a fresh account with no ties at all", async () => {
    await inRollback(async (tx) => {
      await buildFixture(tx);
      const promotee = await insertPromotee(tx);

      const attempt = await attemptPromotion(tx, promotee);

      expect(attempt.affected).toBe(1);
      expect(attempt.role).toBe("platform_ops");
      expect(attempt.leftovers).toEqual([]);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the email arms, with the invitation not yet attached", () => {
  const ACCOUNT_EMAIL = "Mixed.Case@Example.com";

  // Each case adds one invitation addressed to the account's email as the application normalizes it,
  // with `target_user_id` NULL, so the id arms cannot be what catches it.
  const addUnattachedInvitation = async (
    tx: Sql,
    table: string,
    fixture: Fixture,
    invitedEmail: string,
  ): Promise<void> => {
    const id = randomUUID();

    if (table === "institution_invitations") {
      await tx`insert into institution_invitations (id, institution_id, invited_email, invited_role, token_hash, expires_at, invited_by_user_id)
        values (${id}, ${fixture.institution}, ${invitedEmail}, 'institution_staff', 'oracle-hash', ${EXPIRES_AT}, ${fixture.bystander})`;
      return;
    }

    await tx`insert into team_invitations (id, team_id, invited_email, token_hash, expires_at)
      values (${id}, ${fixture.bystanderTeam}, ${invitedEmail}, 'oracle-hash', ${EXPIRES_AT})`;
  };

  it.each(EMAIL_KEYED_ARMS.map((arm) => [arm.table, arm] as const))(
    "refuses an account whose address an unattached %s row names",
    async (_name, arm) => {
      await inRollback(async (tx) => {
        const fixture = await buildFixture(tx);
        const promotee = await insertPromotee(tx, ACCOUNT_EMAIL);

        await addUnattachedInvitation(tx, arm.table, fixture, normalizeInviteEmail(ACCOUNT_EMAIL));

        const attempt = await attemptPromotion(tx, promotee);

        expect(attempt.affected).toBe(0);
        expect(attempt.role).toBe("candidate");
        expect(attempt.leftovers.map((leftover) => leftover.source)).toEqual([
          `${arm.table}.${arm.column}`,
        ]);
      });
    },
  );
});

describe.skipIf(skipWithoutDatabase)("what the oracle leaves behind", () => {
  it("leaves the same accounts and the same operators it found", async () => {
    expect(await countAccounts(), "a case committed instead of rolling back").toBe(usersBefore);
  });
});
